// Typed error classes mapped to HTTP status codes by the router.
// Spec: tsh_requirement.md §5.1 (2xx ok; 401 missing/invalid JWT; 403 role denied; 4xx validation; 5xx server).

export class HttpError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = new.target.name;
  }
}

export class BadRequest extends HttpError {
  constructor(message = 'Bad request') {
    super(400, message);
  }
}

export class Unauthorized extends HttpError {
  constructor(message = 'Missing or invalid Google ID token') {
    super(401, message);
  }
}

export class Forbidden extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class NotFound extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class Conflict extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

export class FeatureDisabled extends HttpError {
  constructor(flag: string) {
    super(503, `${flag} is disabled. Toggle it in config/site.json.`);
  }
}

export class UpstreamError extends HttpError {
  constructor(message = 'Upstream error') {
    super(502, message);
  }
}
