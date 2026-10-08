// English display copy for the sales delivery risk and order evidence views
// (src/modules/sales/Page.tsx). Keys are the Chinese labels the page and the
// sales order read API (server/repositories/db-sales-order-read-repository.mjs)
// use. Display labels only: never apply this mapping to stored business values
// such as customer or item names. Labels not listed here fall back to the
// shared workspace dictionary.
export const salesDemandEnglish: Record<string, string> = {
  // Order status labels the read API sends with each order.
  "已暂停": "On hold",
  "可发货": "Ready to ship",
  "部分分配": "Partially allocated",
  // Delivery risk labels.
  "已阻塞": "Blocked",
  // The read API's customer tier and the name it shows when none is recorded.
  "常规客户": "Standard customer",
  "未命名客户": "Unnamed customer",
};
