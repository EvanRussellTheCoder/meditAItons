import { CalComClient } from './cal-com';

describe('CalComClient', () => {
  it('preflights the event type and sends the documented v2 booking payload once', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          data: {
            id: 123,
            lengthInMinutes: 30,
            bookingFields: [
              { slug: 'name', required: true },
              { slug: 'email', required: true },
              { slug: 'title', required: true },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            status: 'success',
            data: {
              uid: 'booking-1',
              start: '2026-08-18T23:00:00.000Z',
              end: '2026-08-18T23:30:00.000Z',
              duration: 30,
            },
          },
          201,
        ),
      );
    const client = new CalComClient({
      apiKey: 'cal-test-key',
      eventTypeId: 123,
      fetchImplementation,
    });

    await client.initialize();
    await expect(
      client.book({
        proposalId: 'proposal-1',
        startUtc: '2026-08-18T23:00:00.000Z',
        timezone: 'America/New_York',
        attendeeName: 'Test User',
        attendeeEmail: 'test@example.com',
      }),
    ).resolves.toMatchObject({ success: true, bookingUid: 'booking-1' });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [preflightUrl, preflightInit] = fetchImplementation.mock.calls[0];
    expect(preflightUrl).toBe('https://api.cal.com/v2/event-types/123');
    expect(new Headers(preflightInit?.headers).get('cal-api-version')).toBe('2024-06-14');
    const [bookingUrl, bookingInit] = fetchImplementation.mock.calls[1];
    expect(bookingUrl).toBe('https://api.cal.com/v2/bookings');
    expect(new Headers(bookingInit?.headers).get('cal-api-version')).toBe('2026-02-25');
    expect(new Headers(bookingInit?.headers).get('authorization')).toBe('Bearer cal-test-key');
    expect(JSON.parse(String(bookingInit?.body))).toEqual({
      start: '2026-08-18T23:00:00.000Z',
      eventTypeId: 123,
      attendee: {
        name: 'Test User',
        email: 'test@example.com',
        timeZone: 'America/New_York',
        language: 'en',
      },
      bookingFieldsResponses: { title: 'Meditation practice' },
      metadata: { proposalId: 'proposal-1', source: 'meditaitons' },
    });
  });

  it('marks a network failure as uncertain and does not retry the booking POST', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          data: { id: 123, lengthInMinutes: 30, bookingFields: [] },
        }),
      )
      .mockRejectedValueOnce(new Error('socket closed'));
    const client = new CalComClient({
      apiKey: 'cal-test-key',
      eventTypeId: 123,
      fetchImplementation,
    });
    await client.initialize();

    await expect(
      client.book({
        proposalId: 'proposal-1',
        startUtc: '2026-08-18T23:00:00.000Z',
        timezone: 'America/New_York',
        attendeeName: 'Test User',
        attendeeEmail: 'test@example.com',
      }),
    ).resolves.toEqual({
      success: false,
      statusCode: 502,
      errorCode: 'calendar_network_error',
      message: 'Cal.com could not be reached, so the booking status is uncertain.',
      outcomeUncertain: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed success response as uncertain to prevent a duplicate retry', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          data: { id: 123, lengthInMinutes: 30, bookingFields: [] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'success', data: {} }, 201));
    const client = new CalComClient({
      apiKey: 'cal-test-key',
      eventTypeId: 123,
      fetchImplementation,
    });
    await client.initialize();

    await expect(
      client.book({
        proposalId: 'proposal-1',
        startUtc: '2026-08-18T23:00:00.000Z',
        timezone: 'America/New_York',
        attendeeName: 'Test User',
        attendeeEmail: 'test@example.com',
      }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'calendar_invalid_response',
      outcomeUncertain: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
