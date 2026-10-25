// Mọi transaction sẽ throw ra DomainException này để xử lý lỗi
// Chuẩn hóa lỗi gồm 3 tường Mã HTTP, Code lỗi nội bộ, Message
export class DomainException extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, any>,
  ) {
    super(message);
    this.name = 'DomainException';
  }
}

// B1: Xử lý lỗi thông thường
// B2: Xử lý lỗi domain
