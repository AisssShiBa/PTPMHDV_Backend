# Sửa lỗi khởi động phát hiện khi nghiệm thu H01

12/11/2026, theo yêu cầu người dùng sửa toàn bộ lỗi chặn. Base BE 1792e65f76cf175700900e21ccabea4c055c6aaf; thay đổi chưa commit. [Evidence frontend và live](../../../PTPMHDV_Frontend/docs/evidence/huu-fe-phase1/final/README.md).

- Gateway lazy Redis không tự connect trong khi limiter từ chối Auth trước khi gọi Redis; thêm connect độc lập ngoài NODE_ENV=test, giữ fail-closed khi Redis thực sự unavailable. Typecheck Gateway PASS; live signup/login đi qua Gateway PASS sau sửa.
- Wallet migration 20261106120000 rename TOPUP_POOL lần thứ hai sau migration 20261104103000. Guard enum theo regtype/search_path, chấp nhận đã rename và fail-closed nếu thiếu cả source/target. Không sửa row/ledger/số dư. 3 regression PostgreSQL PASS bằng BEGIN/ROLLBACK trên schema riêng.
- Auth schema có Session.familyId/revokedAt nhưng thiếu migration; thêm migration 20261112120000_session_refresh_rotation với backfill familyId=id cho row chưa có và index. Bảo toàn hash, expiry và family đã tồn tại. 2 regression PostgreSQL PASS. Image Auth đã rebuild/apply và signin/refresh/logout thực PASS.
- Acceptance runtime override thiếu redis_password/redis_url; bổ sung đúng secrets của project mới. SQL init cần database user đọc nên mode 0644 trong parent private 0700; credential files khác vẫn 0600. FINVAULT_ACCEPTANCE_ROOTLESS=1 chỉ thêm label=disable cho override test trên SELinux/Podman, không đổi production compose.

Lượt này dùng project mới finvault-acceptance-dadc7eef7537, volumes/cổng/secrets riêng, không xóa DB/volume. Migration thất bại của chính DB thử được đánh rolled-back rồi deploy lại sau rebuild; không chạy resolve trên bất kỳ DB hiện hữu nào. Project đã dừng, giữ volumes/evidence trong .cache/acceptance-week2.

**Lưu ý bàn giao migration:** bản sửa Wallet thay nội dung một migration lịch sử; DB đã apply migration đó có thể có checksum cũ. Trước khi triển khai ngoài stack thử phải đối chiếu lịch sử DB với owner, không tự sửa bảng _prisma_migrations hoặc chạy resolve bừa để bỏ qua drift. Migration Session mới không cần sửa checksum cũ.

Lệnh regression (khi container acceptance PostgreSQL còn chạy):

```bash
DOCKER_HOST=unix:///tmp/huu-fe-podman.sock \
WALLET_MIGRATION_TEST_CONTAINER=finvault-acceptance-dadc7eef7537-postgres-1 \
node --test services/wallet-service/tests/system-wallet-migration.test.cjs
DOCKER_HOST=unix:///tmp/huu-fe-podman.sock \
AUTH_MIGRATION_TEST_CONTAINER=finvault-acceptance-dadc7eef7537-postgres-1 \
node --test services/auth-service/tests/session-migration.test.cjs
```

Không sửa demo-seed.mjs/demo-seed.verify.mjs hoặc các handover có sẵn chưa track của người dùng. Không commit/push/merge.
