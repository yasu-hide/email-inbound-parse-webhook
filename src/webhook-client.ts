export async function postWebhook(webhookUrl: string, form: FormData): Promise<void> {
	try {
		const res = await fetch(webhookUrl, { method: 'POST', body: form });
		if (res.ok) {
			console.info('webhook.post_success', { status: res.status });
		} else {
			console.error('webhook.post_failure', { status: res.status });
		}
	} catch (e) {
		console.error('webhook.post_error', { error: String(e) });
	}
}
