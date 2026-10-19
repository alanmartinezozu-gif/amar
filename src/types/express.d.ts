declare global {
  namespace Express {
    interface Request {
      /** Raw request body, kept for webhook signature checks. */
      rawBody?: Buffer;
    }
  }
}

export {};
