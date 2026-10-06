import { useCallback } from "react";
import { useI18n } from "../../i18n/I18n";

// Display copy for purchase order issue dates and price history. English is
// the source; zh-CN is chosen by the interface language. Codes, currencies,
// numbers and dates are passed in already formatted and are never translated.
// Every price here is a purchase order price, never a paid price.
const COPY = {
  "en-US": {
    issued: "Issue date",
    issuedOn: "Issued {date}",
    issueDateNotRecorded: "Issue date not recorded",
    title: "Earlier purchase orders",
    lastPoPrice: "Last PO price {price} / {unit} · {po} · {date} · {supplier}",
    earlierPo: "Earlier: {price} / {unit} · {po} · {date} · {supplier}",
    lastPoPriceHidden: "Last PO price hidden for your role · {po} · {date} · {supplier}",
    earlierPoHidden: "Earlier: price hidden · {po} · {date} · {supplier}",
    orderedNoIssueDate: "{date} (ordered · issue date not recorded)",
    dateNotRecorded: "date not recorded",
    supplierNotRecorded: "supplier not recorded",
    averageOf: "Average of {n}: {price}",
    noIssuedPo: "No issued PO for this item yet",
    otherCurrency: "Earlier purchases in {list}, not compared",
    otherUnit: "Earlier purchases in {list}, not compared",
    unitNotRecorded: "Unit not recorded, not compared",
    unitNotRecordedLines: "{n} earlier lines have no unit recorded, not compared",
    unitNotRecordedLinesOne: "1 earlier line has no unit recorded, not compared",
    pricesHidden: "price hidden for your role",
    loading: "Reading earlier purchase orders…",
    error: "Earlier purchase orders could not be read.",
    poPriceNote: "Prices ordered on issued purchase orders in the same unit and currency, not invoiced or paid prices. Nothing is filled in from them.",
    vsLastPo: "vs last PO {price} ({po}, {date}): {pct}",
    averageShort: "average of {n}: {price}",
    withAverage: "{last}; {average}",
    notComparable: "Not comparable: {what}",
    noEarlierPo: "No earlier PO",
    unitNotRecordedShort: "unit not recorded",
    zeroBase: "Not comparable: earlier price 0",
    quoteHidden: "Earlier PO prices are hidden for your role",
    copyNote: "Copy note",
    noteCopied: "Note copied. Nothing was sent.",
    noteCopyFailed: "The note could not be copied.",
    noteTemplate: "Hello {supplier},\n\nThank you for your quotation for {rfq}. For reference, our recent purchase orders for the same items:\n{lines}\n\nCould you review your prices with this in mind?\n\nBest regards",
    noteLine: "- {item}: quoted {quote} / {unit}; our last PO {last} ({po}, {date}){average}",
    noteAverage: "; average of {n}: {price}",
  },
  "zh-CN": {
    issued: "下达日期",
    issuedOn: "{date} 下达",
    issueDateNotRecorded: "未记录下达日期",
    title: "以往采购订单",
    lastPoPrice: "上次采购订单价 {price} / {unit} · {po} · {date} · {supplier}",
    earlierPo: "更早：{price} / {unit} · {po} · {date} · {supplier}",
    lastPoPriceHidden: "上次采购订单价对当前角色隐藏 · {po} · {date} · {supplier}",
    earlierPoHidden: "更早：价格已隐藏 · {po} · {date} · {supplier}",
    orderedNoIssueDate: "{date}（下单日期 · 未记录下达日期）",
    dateNotRecorded: "未记录日期",
    supplierNotRecorded: "未记录供应商",
    averageOf: "{n} 笔平均：{price}",
    noIssuedPo: "该物料尚无已下达的采购订单",
    otherCurrency: "以往采购以 {list} 计，未比较",
    otherUnit: "以往采购以 {list} 计，未比较",
    unitNotRecorded: "未记录单位，未比较",
    unitNotRecordedLines: "{n} 个以往采购行未记录单位，未比较",
    unitNotRecordedLinesOne: "1 个以往采购行未记录单位，未比较",
    pricesHidden: "当前角色不可查看价格",
    loading: "正在读取以往采购订单…",
    error: "以往采购订单读取失败。",
    poPriceNote: "以下为已下达采购订单上相同单位和币种的订购价格，不是发票或付款价格，不会自动填入。",
    vsLastPo: "对比上次采购订单 {price}（{po}，{date}）：{pct}",
    averageShort: "{n} 笔平均：{price}",
    withAverage: "{last}；{average}",
    notComparable: "无法比较：{what}",
    noEarlierPo: "无以往采购订单",
    unitNotRecordedShort: "未记录单位",
    zeroBase: "无法比较：以往价格为 0",
    quoteHidden: "当前角色不可查看以往采购订单价格",
    copyNote: "复制备注",
    noteCopied: "备注已复制，未发送任何内容。",
    noteCopyFailed: "备注复制失败。",
    noteTemplate: "{supplier} 您好：\n\n感谢您就 {rfq} 提供报价。供参考，我们近期相同物料的采购订单如下：\n{lines}\n\n请据此复核报价。\n\n此致",
    noteLine: "- {item}：报价 {quote} / {unit}；我们上次采购订单 {last}（{po}，{date}）{average}",
    noteAverage: "；{n} 笔平均：{price}",
  },
} as const;

export type PriceHistoryCopyKey = keyof (typeof COPY)["en-US"];

export function priceHistoryText(language: string, key: PriceHistoryCopyKey, params: Record<string, string | number> = {}) {
  const table = COPY[language === "zh-CN" ? "zh-CN" : "en-US"];
  return Object.entries(params).reduce((value, [name, replacement]) => value.split(`{${name}}`).join(String(replacement)), table[key] as string);
}

// The "One" form of a message for a count of 1, else the message.
export function priceHistoryCount(language: string, key: PriceHistoryCopyKey, count: number, params: Record<string, string | number> = {}) {
  const one = `${key}One` as PriceHistoryCopyKey;
  return priceHistoryText(language, count === 1 && one in COPY["en-US"] ? one : key, { n: count, ...params });
}

export function usePriceHistoryCopy() {
  const { language } = useI18n();
  const t = useCallback((key: PriceHistoryCopyKey, params?: Record<string, string | number>) => priceHistoryText(language, key, params), [language]);
  const count = useCallback((key: PriceHistoryCopyKey, n: number, params?: Record<string, string | number>) => priceHistoryCount(language, key, n, params), [language]);
  return Object.assign(t, { count, language });
}
