export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
  }
}

export interface AuthContext {
  userId: string;
}

export function requireAuth(request: Request): AuthContext {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing bearer token", 401);
  }

  const userId = header.slice("Bearer ".length).trim();
  if (!userId) {
    throw new AuthError("Invalid token", 401);
  }

  return { userId };
}
