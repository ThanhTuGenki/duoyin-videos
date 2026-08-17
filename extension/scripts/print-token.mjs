// In OAuth token của extension ra stdout (dùng để gọi Drive/Sheets API từ nơi khác).
// Token sống ~1 giờ. Chỉ chạy được khi Chrome dev đang mở cổng 9223.
import { getToken } from "./lib/token.mjs";
process.stdout.write(await getToken());
