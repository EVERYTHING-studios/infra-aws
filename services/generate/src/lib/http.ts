import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, code: string, message: string): APIGatewayProxyResultV2 {
  return json(statusCode, { error: { code, message } });
}

/**
 * The customer API Gateway authorizer's context is not on this aws-lambda
 * version's APIGatewayEventRequestContextV2, so read it structurally.
 */
export function authorizerUserId(event: APIGatewayProxyEventV2): string | null {
  const context = (
    event.requestContext as typeof event.requestContext & {
      authorizer?: { lambda?: { user_id?: unknown } };
    }
  ).authorizer;
  const userId = context?.lambda?.user_id;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}
