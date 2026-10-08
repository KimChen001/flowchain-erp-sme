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
  // Labels of the JSON sales demand read model
  // (server/domain/sales-demand-read-model.mjs), when that model is served.
  "部分发货": "Partially shipped",
  // Delivery risk labels.
  "已阻塞": "Blocked",
  // The JSON read model's risk reasons.
  "库存缺口叠加采购到货风险，承诺交付需优先复核。": "Stock shortage combined with inbound purchase risk. Review the promised delivery first.",
  "当前客户订单数量超过已预留数量，存在交付缺口。": "The ordered quantity exceeds the reserved quantity, so a delivery shortage remains.",
  "采购在途或供应商风险可能影响承诺交付。": "Inbound purchases or supplier risk may affect the promised delivery.",
  "当前库存与采购证据未显示明显交付风险。": "Current inventory and purchasing records show no clear delivery risk.",
  // The read API's customer tier and the name it shows when none is recorded.
  "常规客户": "Standard customer",
  "未命名客户": "Unnamed customer",
};
