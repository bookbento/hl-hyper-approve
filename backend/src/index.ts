// backend\src\index.ts

import app from "./app";
import { scheduleMemoExpiry } from "./lib/memo-expiry";

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
  scheduleMemoExpiry();
});

