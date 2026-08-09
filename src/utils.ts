export function extractAmountFromText(text: string): number | null {
	if (!text || typeof text !== 'string') {
		return null;
	}

	const textWithNormalizedSpaces = text.replace(/\u00A0/g, ' ');
	const amountToken = textWithNormalizedSpaces.match(/-?\d[\d.,]*/)?.[0] ?? '';
	const cleaned = amountToken.replace(/[.,]+$/, '').trim();

	if (!cleaned) {
		return null;
	}

	const commaAsDecimal = /^-?\d{1,3}(\.\d{3})*,\d+$/;
	const dotAsDecimal = /^-?\d{1,3}(,\d{3})*\.\d+$/;

	let normalized = cleaned;

	if (commaAsDecimal.test(cleaned)) {
		normalized = cleaned.replace(/\./g, '').replace(',', '.');
	} else if (dotAsDecimal.test(cleaned)) {
		normalized = cleaned.replace(/,/g, '');
	} else {
		normalized = cleaned.replace(/,/g, '.');
	}

	const numericValue = Number(normalized);
	return Number.isFinite(numericValue) ? numericValue : null;
}