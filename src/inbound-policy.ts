type InboundMessage = {
	from?: string;
	to?: string;
	rawSize?: number;
	setReject?: (reason: string) => void;
};

function safeSetReject(message: InboundMessage, reason: string) {
	try {
		message.setReject?.(reason);
	} catch (err) {
		console.error('setReject failed', String(err));
	}
}

export function ensureWebhookConfigured(message: InboundMessage, webhookUrl?: string): webhookUrl is string {
	if (webhookUrl) return true;
	console.error('email.rejected.no_webhook', { from: message.from, to: message.to });
	safeSetReject(message, 'WEBHOOK_URL not configured');
	return false;
}

export function rejectIfMessageTooLarge(message: InboundMessage, maxMessageSize: number): boolean {
	if (typeof message.rawSize === 'number' && message.rawSize > maxMessageSize) {
		console.warn('email.rejected.too_large', { size: message.rawSize, max: maxMessageSize });
		safeSetReject(message, 'Message too large');
		return true;
	}
	return false;
}

export function rejectParsingError(message: InboundMessage, error: unknown) {
	console.error('email.parse_error', { error: String(error) });
	safeSetReject(message, 'Parsing error');
}
