import { BadRequestException, Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
  passwordExpired?: boolean;
};

export type BdvPaymentToVerify = {
  id: string;
  amount: number;
  reference: string;
};

export type BdvPaymentVerificationResult = VerifyPaymentBancoDeVenezuelaResult & {
  id: string;
};

@Injectable()
export class BankAutomationService {
  /** Una sola sesión de navegador a la vez: el banco no admite dos ingresos de la misma cuenta. */
  private browserGate: Promise<void> = Promise.resolve();

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
    const [result] = await this.verifyPaymentsBDV({
      credentials: payload.credentials,
      payments: [
        {
          id: 'single',
          amount: payload.paymentData.amount,
          reference: payload.paymentData.reference,
        },
      ],
    });

    return {
      error: result?.error ?? 'No se pudo completar la verificacion automatica.',
      isTechnicalError: result?.isTechnicalError ?? true,
      movementIsCorrect: result?.movementIsCorrect ?? false,
      movements: result?.movements,
      invalidCredentials: result?.invalidCredentials,
      passwordExpired: result?.passwordExpired,
    };
  }

  /**
   * Entra una vez al banco y contrasta varios pagos en la misma tabla de movimientos.
   * Al terminar cierra el navegador. El cierre de sesión en la página queda pendiente.
   */
  async verifyPaymentsBDV(payload: {
    credentials?: CredentialsConfig;
    payments: BdvPaymentToVerify[];
  }): Promise<BdvPaymentVerificationResult[]> {
    if (payload.payments.length === 0) {
      return [];
    }

    return this.withBrowserLock(() => this.verifyPaymentsInOneSession(payload));
  }

  private async withBrowserLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.browserGate;
    let release!: () => void;
    this.browserGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async verifyPaymentsInOneSession(payload: {
    credentials?: CredentialsConfig;
    payments: BdvPaymentToVerify[];
  }): Promise<BdvPaymentVerificationResult[]> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const timeout = 45000;
    const movementsTableSelector =
      '#print-section > div:nth-child(3) > div > div.table-container > mat-table';

    try {
      browser = await chromium.launch({
        headless: true,
      });
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto('https://bdvenlinea.banvenez.com/', {
        timeout,
        waitUntil: 'domcontentloaded',
      });

      await page.fill(
        "input[formcontrolname='username']",
        payload.credentials?.username ?? '',
      );
      await page.click('.button-login-container > .mat-raised-button');
      await page.waitForSelector("input[name='password']", { timeout });

      const passwordInputSelector = "input[name='password']";
      const submitButtonSelector =
        'app-confirmar-acceso > div > form > div:nth-child(2) > div > button.mat-raised-button.mat-accent.ng-touched.ng-dirty.ng-valid';
      const movementsEntrySelector =
        '#cdk-accordion-child-1  table.table-saldo-cuenta > tbody > tr > td:nth-child(3) > mat-icon';

      await page.click(passwordInputSelector);
      await page.fill(passwordInputSelector, '');
      await page.type(passwordInputSelector, payload.credentials?.password ?? '', {
        delay: 35,
      });
      await page.press(passwordInputSelector, 'Tab');
      await page.waitForSelector(submitButtonSelector, { timeout });
      await page.click(submitButtonSelector);

      let loginOutcome: 'invalid-credentials' | 'expired-password' | 'success';
      try {
        loginOutcome = await this.waitForLoginOutcome(page, movementsEntrySelector, 8000);
      } catch {
        await page.click(passwordInputSelector);
        await page.press(passwordInputSelector, 'Tab');
        await page.click(submitButtonSelector);
        loginOutcome = await this.waitForLoginOutcome(page, movementsEntrySelector, timeout);
      }

      if (loginOutcome === 'expired-password') {
        return payload.payments.map((payment) => ({
          id: payment.id,
          error: 'La contraseña del banco está vencida.',
          isTechnicalError: false,
          movementIsCorrect: false,
          passwordExpired: true,
        }));
      }

      if (loginOutcome === 'invalid-credentials') {
        return payload.payments.map((payment) => ({
          id: payment.id,
          error: 'El usuario o la contraseña son incorrectos.',
          isTechnicalError: false,
          movementIsCorrect: false,
          invalidCredentials: true,
        }));
      }

      await page.click(movementsEntrySelector);
      await page.waitForSelector("input[placeholder='Buscar']", { timeout });
      await page.waitForSelector(movementsTableSelector, { timeout });
      await page.waitForSelector(
        '#print-section > div:nth-child(3) > div > mat-paginator',
        { timeout },
      );
      await this.sleep(5);

      const results: BdvPaymentVerificationResult[] = [];
      for (const payment of payload.payments) {
        results.push(await this.searchMovement(page, payment, movementsTableSelector, timeout));
      }
      return results;
    } catch (error) {
      console.log('Error in verifyPaymentsBDV: ', error);
      await page?.screenshot({ path: 'error.png' }).catch(() => undefined);
      await this.sleep(2);
      return payload.payments.map((payment) => ({
        id: payment.id,
        error: `No se pudo completar la verificacion automatica: ${String(error)}`,
        isTechnicalError: true,
        movementIsCorrect: false,
      }));
    } finally {
      await context?.close();
      await browser?.close();
    }
  }

  private async searchMovement(
    page: Page,
    payment: BdvPaymentToVerify,
    movementsTableSelector: string,
    timeout: number,
  ): Promise<BdvPaymentVerificationResult> {
    try {
      const search = page.locator("input[placeholder='Buscar']");
      await search.fill('');
      await search.fill(payment.reference);
      await search.press('Enter');
      await this.sleep(1);
      await page.waitForSelector(movementsTableSelector, { timeout });

      const movements = await this.extractBancoDeVenezuelaMovements(page);
      const matchedMovement = movements.find((movement) => {
        const amountMatches = extractAmountFromText(movement.amount) === payment.amount;
        const referenceMatches = movement.reference.includes(payment.reference);
        return amountMatches && referenceMatches;
      });

      return {
        id: payment.id,
        error: '',
        isTechnicalError: false,
        movementIsCorrect: !!matchedMovement,
        movements,
      };
    } catch (error) {
      console.log(`Error buscando referencia ${payment.reference}: `, error);
      return {
        id: payment.id,
        error: `No se pudo consultar la referencia ${payment.reference}: ${String(error)}`,
        isTechnicalError: true,
        movementIsCorrect: false,
      };
    }
  }

  async sleep(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private async waitForLoginOutcome(
    page: Page,
    movementsEntrySelector: string,
    timeoutMs: number,
  ): Promise<'invalid-credentials' | 'expired-password' | 'success'> {
    const invalidCredentials = page
      .locator('snack-bar-container:has-text("Autenticación incorrecta.")')
      .getByText('Autenticación incorrecta.', { exact: true });
    const expiredPassword = page
      .locator('snack-bar-container:has-text("Contraseña vencida")')
      .getByText('Contraseña vencida', { exact: true });
    const movementsEntry = page.locator(movementsEntrySelector);

    await invalidCredentials.or(expiredPassword).or(movementsEntry).waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });

    if (await expiredPassword.isVisible()) {
      return 'expired-password';
    }

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
