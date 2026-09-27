/**
 * BobApiClient.ts — Secondary/fallback Bob provider using the Bob REST API.
 *
 * This is a skeleton implementation. The full REST API integration will be
 * completed once the Bob REST API endpoint and authentication mechanism
 * are confirmed. The interface is identical to BobShellClient.
 *
 * Required environment variables:
 *   BOB_API_URL  — Base URL of the Bob REST API
 *   BOB_API_KEY  — API key for the Bob REST API
 */

import type { BobClient, BobTaskOptions, BobTaskResult, BobProviderStatus } from './BobClient';

export class BobApiClient implements BobClient {
  readonly provider = 'api' as const;

  private get apiUrl(): string {
    const url = process.env['BOB_API_URL'];
    if (!url) throw new Error('BOB_API_URL environment variable is required for Bob API provider');
    return url;
  }

  private get apiKey(): string {
    const key = process.env['BOB_API_KEY'];
    if (!key) throw new Error('BOB_API_KEY environment variable is required for Bob API provider');
    return key;
  }

  async runTask(options: BobTaskOptions): Promise<BobTaskResult> {
    const startTime = Date.now();
    const taskId = options.taskId ?? `api-${Date.now()}`;

    // TODO: Implement REST API call once Bob REST API spec is confirmed.
    // The implementation will:
    //   1. POST to ${this.apiUrl}/tasks with the task options
    //   2. Poll or stream the response
    //   3. Return the structured result
    //
    // Placeholder: fail clearly so the developer knows this is not yet implemented.
    console.warn('[BobApiClient] REST API provider is not yet implemented. Configure BOB_PROVIDER=shell to use Bob Shell.');

    return {
      taskId,
      success: false,
      output: '',
      durationMs: Date.now() - startTime,
      error: 'BOB_UNAVAILABLE: REST API provider is not yet implemented. Use BOB_PROVIDER=shell.',
      errorKind: 'not_implemented',
    };
  }

  async checkAvailability(): Promise<BobProviderStatus> {
    try {
      const url = this.apiUrl;
      const key = this.apiKey;
      if (!url || !key) {
        return { provider: 'api', available: false, code: 'BOB_UNAVAILABLE', error: 'BOB_API_URL or BOB_API_KEY not set' };
      }
      // TODO: ping health endpoint when REST API spec is confirmed
      return { provider: 'api', available: false, code: 'BOB_UNAVAILABLE', error: 'REST API provider not yet implemented' };
    } catch (err) {
      return {
        provider: 'api',
        available: false,
        code: 'BOB_UNAVAILABLE',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
