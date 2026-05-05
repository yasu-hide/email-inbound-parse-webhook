import { createWebhookSignatureHeaders } from './webhook-signature';

type SerializedFormData = {
	body: ArrayBuffer;
	contentType: string;
};

async function serializeFormData(form: FormData): Promise<SerializedFormData> {
	const request = new Request('https://webhook.invalid/', {
		method: 'POST',
		body: form,
	});
	const contentType = request.headers.get('content-type');
	if (!contentType) {
		throw new Error('Failed to serialize webhook FormData content type.');
	}

	return {
		body: await request.arrayBuffer(),
		contentType,
	};
}

export async function postWebhook(webhookUrl: string, form: FormData, privateKey: string): Promise<void> {
	const { body, contentType } = await serializeFormData(form);
	const signatureHeaders = await createWebhookSignatureHeaders({
		privateKey,
		rawBody: body,
	});

	try {
		const res = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'content-type': contentType,
				...signatureHeaders,
			},
			body,
		});
		if (res.ok) {
			console.info('webhook.post_success', { status: res.status });
		} else {
			console.error('webhook.post_failure', { status: res.status });
		}
	} catch (e) {
		console.error('webhook.post_error', { error: String(e) });
	}
}
