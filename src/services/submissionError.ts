export class OrderSubmissionError extends Error {
  constructor(public readonly uid: string, public readonly rejected: boolean, detail: string) {
    super(detail);
    this.name = 'OrderSubmissionError';
  }
}
