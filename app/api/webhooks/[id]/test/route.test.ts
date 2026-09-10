import { NextRequest } from 'next/server';

const {
  parseAccessTokenMock,
  getWebhookMock,
  updateWebhookMock,
  sendTestWebhookMock,
} = vi.hoisted(() => ({
  parseAccessTokenMock: vi.fn(),
  getWebhookMock: vi.fn(),
  updateWebhookMock: vi.fn(),
  sendTestWebhookMock: vi.fn(),
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));
vi.mock('@/lib/webhooks/service', () => ({ sendTestWebhook: sendTestWebhookMock }));
vi.mock('@/lib/db', () => ({
  getDatabase: () => ({
    webhooks: { getById: getWebhookMock, update: updateWebhookMock },
  }),
}));

import { POST } from '@/app/api/webhooks/[id]/test/route';

const webhook = {
  id: 'w1',
  user_id: 'user-1',
  name: 'Test',
  url: 'https://example.com/hook',
  webhook_type: 'teams',
  secret: null,
  headers: {},
  is_enabled: true,
  failure_count: 0,
};

function post() {
  const request = new NextRequest('http://localhost:3000/api/webhooks/w1/test', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
  });
  return POST(request, { params: Promise.resolve({ id: 'w1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  parseAccessTokenMock.mockResolvedValue({
    userId: 'user-1',
    userEmail: 'user@example.com',
    tenantId: 'tenant-1',
    userName: 'User',
  });
  getWebhookMock.mockResolvedValue(webhook);
  updateWebhookMock.mockResolvedValue(webhook);
  sendTestWebhookMock.mockResolvedValue({ success: true, statusCode: 200 });
});

describe('POST /api/webhooks/[id]/test', () => {
  it('sends a test payload without Supabase', async () => {
    // Regression: this route called createServerClient() unguarded, which
    // throws without Supabase, so the test button answered a bare
    // "Internal server error" - the delivery itself needs no database.
    const body = await (await post()).json();

    expect(body.success).toBe(true);
    expect(body.statusCode).toBe(200);
    expect(sendTestWebhookMock).toHaveBeenCalledWith(webhook);
  });

  it('records a success on the webhook', async () => {
    await post();

    expect(updateWebhookMock).toHaveBeenCalledWith(
      'w1',
      'user-1',
      expect.objectContaining({ failure_count: 0, last_success_at: expect.any(String) })
    );
  });

  it('counts a failed test towards the circuit breaker', async () => {
    getWebhookMock.mockResolvedValue({ ...webhook, failure_count: 2 });
    sendTestWebhookMock.mockResolvedValue({ success: false, error: 'HTTP 403' });

    const body = await (await post()).json();

    expect(body.success).toBe(false);
    expect(body.error).toBe('HTTP 403');
    expect(updateWebhookMock).toHaveBeenCalledWith(
      'w1',
      'user-1',
      expect.objectContaining({ failure_count: 3, last_failure_at: expect.any(String) })
    );
  });

  it('does not test a webhook belonging to someone else', async () => {
    // The id is the only thing the client sends, and the row holds an HMAC
    // secret - so the lookup carries the user.
    getWebhookMock.mockResolvedValue(null);

    const response = await post();

    expect(response.status).toBe(404);
    expect(sendTestWebhookMock).not.toHaveBeenCalled();
  });

  it('returns 401 without valid auth', async () => {
    parseAccessTokenMock.mockResolvedValue(null);

    expect((await post()).status).toBe(401);
    expect(getWebhookMock).not.toHaveBeenCalled();
  });
});
