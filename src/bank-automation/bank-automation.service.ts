import { BadRequestException, Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import path from 'path';
import { chromium, type Page } from 'playwright';
import { extractAmountFromText } from '../utils';
import { UploadedImage } from './bank-automation.controller';
import { OpenaiExtractionService } from '../openai-extraction/openai-extraction.service';

type SelectorConfig = {
  usernameInput?: string;
  passwordInput?: string;
  submitButton?: string;
  rows: string;
  amountCell?: string;
  referenceCell?: string;
  dateCell?: string;
};

type CredentialsConfig = {
  username?: string;
  password?: string;
};

type ExpectedPayment = {
  amount: number;
  referenceContains?: string;
  fromDate?: string;
  toDate?: string;
};

export type VerifyPaymentRequest = {
  loginUrl: string;
  movementsUrl: string;
  selectors: SelectorConfig;
  expected: ExpectedPayment;
  credentials?: CredentialsConfig;
  storageStatePath?: string;
  navigationTimeoutMs?: number;
  headless?: boolean;
};

type ExtractedMovement = {
  amount: number;
  amountRaw: string;
  reference: string;
  dateRaw: string;
  text: string;
};

export type BancoDeVenezuelaMovement = {
  date: string;
  reference: string;
  description: string;
  debitCredit: string;
  amount: string;
  balance: string;
  text: string;
};

export type VerifyPaymentBancoDeVenezuelaRequest = {
  credentials?: CredentialsConfig;
  paymentData: {
    amount: number;
    reference: string;
  };
};

export type VerifyPaymentBancoDeVenezuelaResult = {
  error: string;
  /** true = falla técnica (página, timeout, login); se puede reintentar */
  isTechnicalError: boolean;
  movementIsCorrect: boolean;
  movements?: BancoDeVenezuelaMovement[];
  invalidCredentials?: boolean;
};

@Injectable()
export class BankAutomationService {
  constructor(private readonly openaiExtractionService: OpenaiExtractionService) {}

  async processPaymentScreenshotBancoDeVenezuela(file?: UploadedImage) {
    if (!file) {
      throw new BadRequestException('Debes enviar la imagen en el campo "image".');
    }
    
    const result = await this.openaiExtractionService.extractTransferDataFromImage(file.buffer, file.mimetype);
    
    console.log("Extracted result from OpenAI:", result);
    return this.verifyPaymentBDV({
      credentials: {
        username: "yeisserc",
        password: "Saulfat31."
      },
      paymentData: {
        amount: result.amount ?? 0,
        reference: result.reference ?? "",
      }
    })
  }

  async verifyPaymentBDV(
    payload: VerifyPaymentBancoDeVenezuelaRequest,
  ): Promise<VerifyPaymentBancoDeVenezuelaResult> {

    console.log("Verifying payment with payload:", payload);

    const browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext();

    const page = await context.newPage();
    const timeout =  45000;

    try {
      // Navigate to the Banco de Venezuela login page
      await page.goto("https://bdvenlinea.banvenez.com/", {
        timeout,
        waitUntil: 'domcontentloaded',
      });

      // Fill in the username and password fields and submit the form
      await page.fill(
        // "#mat-input-0",
        "input[formcontrolname='username']",
        payload.credentials?.username!,
      );

      await page.click(".button-login-container > .mat-raised-button");

      await page.waitForSelector("input[name='password']", {
        timeout,
      });

      const passwordInputSelector = "input[name='password']";
      // const submitButtonSelector = "button[type='submit']";
      const submitButtonSelector = "app-confirmar-acceso > div > form > div:nth-child(2) > div > button.mat-raised-button.mat-accent.ng-touched.ng-dirty.ng-valid";
      const movementsEntrySelector =
        "#cdk-accordion-child-1  table.table-saldo-cuenta > tbody > tr > td:nth-child(3) > mat-icon";

      // Simulate real user interaction so Angular validations/events are triggered.
      await page.click(passwordInputSelector);
      await page.fill(passwordInputSelector, '');
      await page.type(passwordInputSelector, payload.credentials?.password ?? '', {
        delay: 35,
      });
      await page.press(passwordInputSelector, 'Tab');

      await page.waitForSelector(submitButtonSelector, {
        timeout,
      });
      await page.click(submitButtonSelector);

      let loginOutcome: 'invalid-credentials' | 'success';
      try {
        loginOutcome = await this.waitForLoginOutcome(page, movementsEntrySelector, 8000);
      } catch {
        // Retry once after forcing another blur in case the form was not marked as touched.
        await page.click(passwordInputSelector);
        await page.press(passwordInputSelector, 'Tab');
        await page.click(submitButtonSelector);
        loginOutcome = await this.waitForLoginOutcome(page, movementsEntrySelector, timeout);
      }

      if (loginOutcome === 'invalid-credentials') {
        return {
          error: `El usuario o la contraseña son incorrectos.`,
          isTechnicalError: false,
          movementIsCorrect: false,
          invalidCredentials: true,
        };
      }

      // Click the button to view account movements
      await page.click(movementsEntrySelector);

      // Wait for the account movements page to load and display the table of movements
      // We specifically wait for the input field to search by reference, which indicates that the page has loaded and is ready for interaction
      await page.waitForSelector("input[placeholder='Buscar']", {
        timeout,
      });

      await page.waitForSelector("#print-section > div:nth-child(3) > div > div.table-container > mat-table", {
        timeout,
      });
      
      await page.waitForSelector("#print-section > div:nth-child(3) > div > mat-paginator", {
        timeout,
      });

      await this.sleep(5);
      await page.fill(
        "input[placeholder='Buscar']",
        payload.paymentData.reference,
      );
      await page.press("input[placeholder='Buscar']", 'Enter');

      await this.sleep(1);
      await page.waitForSelector("#print-section > div:nth-child(3) > div > div.table-container > mat-table", {
        timeout,
      });

      const movements = await this.extractBancoDeVenezuelaMovements(page);

      console.log("Movements: ", movements);

      const matchedMovement = movements.find((movement) => {
        console.log("raw amount", movement.amount);
        console.log("extracted amount", extractAmountFromText(movement.amount));
        const amountMatches = extractAmountFromText(movement.amount) === payload.paymentData.amount;
        console.log("extracted reference: ", movement.reference);
        console.log("expected reference: ", payload.paymentData.reference);
        const referenceMatches = movement.reference.includes(payload.paymentData.reference);

        return amountMatches && referenceMatches;
      });

      await this.sleep(5);

      return {
        error: '',
        isTechnicalError: false,
        movementIsCorrect: !!matchedMovement,
        movements,
      };
    } catch (error) {
      console.log("Error in verifyPaymentBDV: ", error);
      page.screenshot({ path: "error.png" });
      await this.sleep(2);
      return {
        error: `No se pudo completar la verificacion automatica: ${String(error)}`,
        isTechnicalError: true,
        movementIsCorrect: false,
      };
    } finally {
      await context.close();
      await browser.close();
    }
  }

  async sleep(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private async waitForLoginOutcome(
    page: Page,
    movementsEntrySelector: string,
    timeoutMs: number,
  ): Promise<'invalid-credentials' | 'success'> {
    const invalidCredentials = page
      .locator('snack-bar-container:has-text("Autenticación incorrecta.")')
      .getByText('Autenticación incorrecta.', { exact: true });
    const movementsEntry = page.locator(movementsEntrySelector);

    await invalidCredentials.or(movementsEntry).waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });

    if (await invalidCredentials.isVisible()) {
      return 'invalid-credentials';
    }

    return 'success';
  }

  private async extractBancoDeVenezuelaMovements(page: Page) {
    const rows = await page.$$eval(
      "#print-section mat-table mat-row",
      (nodes) =>
        nodes.map((node) => {
          const read = (selector: string) => {
            const element = node.querySelector(selector);
            return element?.textContent?.trim() || '';
          };

          return {
            date: read('.cdk-column-fecha'),
            reference: read('.cdk-column-referencia'),
            description: read('.cdk-column-descripcion'),
            debitCredit: read('.cdk-column-indicadorCargoAbono'),
            amount: read('.cdk-column-importe'),
            balance: read('.cdk-column-saldo'),
            text: node.textContent?.trim() || '',
          };
        }),
    );

    return rows as BancoDeVenezuelaMovement[];
  }
}
