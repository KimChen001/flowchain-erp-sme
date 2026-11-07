"""Extract FlowChain's public data data from two public datasets (untrusted input).

    python -I scripts/public-data/extract_public_data.py --uci <online+retail+ii.zip> --m5 <folder> --out <file.json>

Standard library only, so it runs isolated (-I): nothing from the data folders or the
current folder is imported. It reads CSV (M5) and the spreadsheet XML inside the UCI
workbook, refuses any XML part with a DTD, checks every input file against the SHA-256
recorded when it was downloaded, and writes one JSON file. Keep the output outside the
repository: neither dataset nor anything derived from it is committed.

Sources
  UCI Online Retail II: Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning
    Repository. https://doi.org/10.24432/C5CG6D. CC BY 4.0.
  M5 Forecasting Accuracy (Walmart): Makridakis, Spiliotis, Assimakopoulos (2022),
    International Journal of Forecasting 38(4). The owner's local copy; Kaggle's rules
    were not checked, so it stays local.

The selection rules are in RULES below and in docs/public-data-workspaces.md.
"""

import argparse
import csv
import hashlib
import io
import json
import re
import statistics
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

SCHEMA = "flowchain.public-data-extract.v1"
WINDOW_DAYS = 365

UCI_SHA256 = "572e36277c2390fbfde10664750731e0a86f55e33470d91919085f0408e67bfb"
UCI_PRODUCTS = 200
UCI_MIN_SALE_DAYS = 30
UCI_CUSTOMER_MODULUS = 4
UCI_CODE = re.compile(r"^\d{5}[A-Za-z]?$")

M5_SHA256 = {
    "calendar.csv": "d12b5914ef03e66649adf5dd9e996e6602251c22b7a6af8f1f7e3aa12f8860f5",
    "sales_train_evaluation.csv": "4b4a47c44c38380d2a9168216fea8c9ff2f31b1ddb772f8a0995952a038b8aa0",
    "sell_prices.csv": "9da3ad1f8b8ccacdbdc70612191dd375ec24a4ac6625c24b75b3bc60b0bed2ef",
}
M5_STORE = "CA_1"
M5_ITEMS_PER_DEPARTMENT = 30

RULES = {
    "uci": [
        f"window: the {WINDOW_DAYS} days ending on the last invoice day in the data",
        "sale lines: invoice number not starting with C, quantity > 0, price > 0, StockCode of five digits with an optional letter",
        f"products: sold on at least {UCI_MIN_SALE_DAYS} days of the window (all customers); the {UCI_PRODUCTS} with the most units, ties by code",
        "product name: the most frequent description; product price: the median line price in the window",
        f"customers: a Customer ID divisible by {UCI_CUSTOMER_MODULUS} (a fixed one-in-{UCI_CUSTOMER_MODULUS} sample); lines without a Customer ID are left out",
        "orders: each sale invoice of a sampled customer in the window, with its lines for the selected products; lines of one product at one price are added up",
        "cancellations: invoices starting with C of a sampled customer in the window, lines for the selected products",
    ],
    "m5": [
        f"store {M5_STORE}; window: the last {WINDOW_DAYS} days of sales_train_evaluation.csv",
        f"items: in each department the {M5_ITEMS_PER_DEPARTMENT} items with the most units in the window, ties by item_id",
        "daily units as recorded (days without sales are 0)",
        "price: the store's weekly sell price; a week without one takes the nearest earlier week's price, else the nearest later one",
    ],
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message):
    print(f"extract_public_data: {message}", file=sys.stderr)
    raise SystemExit(1)


# ---------------------------------------------------------------- UCI (xlsx)

SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def checked_xml(archive, name):
    """One XML part of the workbook, refused when it declares a DTD or entities."""
    data = archive.read(name)
    head = data[:65536].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        fail(f"{name} declares a DTD; refusing to parse it")
    return data


def column_index(reference):
    letters = re.match(r"[A-Z]+", reference or "")
    if not letters:
        fail(f"cell without a reference: {reference!r}")
    index = 0
    for letter in letters.group(0):
        index = index * 26 + ord(letter) - 64
    return index - 1


def workbook_rows(zip_path):
    """Every row of every sheet as a dict keyed by the sheet's header row."""
    with zipfile.ZipFile(zip_path) as outer:
        names = [name for name in outer.namelist() if name.lower().endswith(".xlsx")]
        if len(names) != 1:
            fail(f"expected one .xlsx in {zip_path}, found {len(names)}")
        info = outer.getinfo(names[0])
        if info.file_size > 200 * 1024 * 1024:
            fail("the workbook is larger than expected")
        workbook = zipfile.ZipFile(io.BytesIO(outer.read(names[0])))
    total = sum(info.file_size for info in workbook.infolist())
    if total > 1024 * 1024 * 1024:
        fail("the workbook expands to more than 1 GB")
    shared = []
    for _, element in ET.iterparse(io.BytesIO(checked_xml(workbook, "xl/sharedStrings.xml")), events=("end",)):
        if element.tag == SHEET_NS + "si":
            shared.append("".join(text.text or "" for text in element.iter(SHEET_NS + "t")))
            element.clear()
    relations = {rel.get("Id"): rel.get("Target") for rel in ET.fromstring(checked_xml(workbook, "xl/_rels/workbook.xml.rels"))}
    sheets = [(sheet.get("name"), relations[sheet.get(REL_NS + "id")]) for sheet in ET.fromstring(checked_xml(workbook, "xl/workbook.xml")).iter(SHEET_NS + "sheet")]
    for sheet_name, target in sheets:
        part = target.lstrip("/")
        part = part if part.startswith("xl/") else f"xl/{part}"
        header = None
        for _, element in ET.iterparse(io.BytesIO(checked_xml(workbook, part)), events=("end",)):
            if element.tag != SHEET_NS + "row":
                continue
            values = {}
            for cell in element.iter(SHEET_NS + "c"):
                kind = cell.get("t")
                raw = cell.find(SHEET_NS + "v")
                if kind == "s":
                    value = shared[int(raw.text)]
                elif kind == "inlineStr":
                    value = "".join(text.text or "" for text in cell.iter(SHEET_NS + "t"))
                elif kind in ("str", "b", "e"):
                    value = raw.text if raw is not None else ""
                else:
                    value = float(raw.text) if raw is not None and raw.text else None
                values[column_index(cell.get("r"))] = value
            element.clear()
            if not values:
                continue
            row = [values.get(index) for index in range(max(values) + 1)]
            if header is None:
                header = [str(name).strip() for name in row]
                missing = {"Invoice", "StockCode", "Description", "Quantity", "InvoiceDate", "Price", "Customer ID", "Country"} - set(header)
                if missing:
                    fail(f"sheet {sheet_name} lacks columns {sorted(missing)}")
                continue
            yield dict(zip(header, row))


EXCEL_EPOCH = datetime(1899, 12, 30)


def as_text(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return "" if value is None else str(value).strip()


def extract_uci(zip_path):
    digest = sha256(zip_path)
    if digest != UCI_SHA256:
        fail(f"{zip_path} has sha256 {digest}, not the recorded {UCI_SHA256}")
    lines = []
    for row in workbook_rows(zip_path):
        when = row.get("InvoiceDate")
        quantity, price = row.get("Quantity"), row.get("Price")
        if not isinstance(when, float) or not isinstance(quantity, float) or not isinstance(price, float):
            continue
        at = (EXCEL_EPOCH + timedelta(days=when)).replace(second=0, microsecond=0)
        customer = as_text(row.get("Customer ID"))
        lines.append((as_text(row.get("Invoice")), as_text(row.get("StockCode")), as_text(row.get("Description")), quantity, at, price, customer, as_text(row.get("Country"))))
    if not lines:
        fail("no invoice lines found in the workbook")
    last_day = max(line[4] for line in lines).date()
    first_day = last_day - timedelta(days=WINDOW_DAYS - 1)
    window = [line for line in lines if first_day <= line[4].date() <= last_day]

    sales = [line for line in window if not line[0].startswith("C") and UCI_CODE.match(line[1]) and line[3] > 0 and line[5] > 0]
    units, sale_days, prices, names = Counter(), defaultdict(set), defaultdict(list), defaultdict(Counter)
    for invoice, code, description, quantity, at, price, customer, country in sales:
        units[code] += quantity
        sale_days[code].add(at.date())
        prices[code].append(price)
        if description:
            names[code][description] += 1
    eligible = [code for code in units if len(sale_days[code]) >= UCI_MIN_SALE_DAYS]
    chosen = sorted(eligible, key=lambda code: (-units[code], code))[:UCI_PRODUCTS]
    selected = set(chosen)
    products = []
    for code in chosen:
        name = sorted(names[code].items(), key=lambda entry: (-entry[1], entry[0]))[0][0] if names[code] else code
        products.append({"code": code, "name": name, "price": round(statistics.median(prices[code]), 2), "units": int(units[code]), "saleDays": len(sale_days[code])})

    def sampled(customer):
        return customer.isdigit() and int(customer) % UCI_CUSTOMER_MODULUS == 0

    def documents(rows, sign):
        grouped = defaultdict(lambda: {"at": None, "customer": None, "countries": Counter(), "lines": defaultdict(float)})
        for invoice, code, _description, quantity, at, price, customer, country in rows:
            if code not in selected or not sampled(customer):
                continue
            document = grouped[invoice]
            document["at"] = at if document["at"] is None or at < document["at"] else document["at"]
            document["customer"] = customer
            document["countries"][country] += 1
            document["lines"][(code, round(price, 2))] += sign * quantity
        result = []
        for number, document in grouped.items():
            kept = [[code, int(round(quantity)), price] for (code, price), quantity in sorted(document["lines"].items()) if round(quantity) > 0]
            if kept:
                result.append({"number": number, "at": document["at"].isoformat(timespec="minutes"), "customer": document["customer"], "country": document["countries"].most_common(1)[0][0], "lines": kept})
        return sorted(result, key=lambda document: (document["at"], document["number"]))

    invoices = documents(sales, 1)
    cancelled = [line for line in window if line[0].startswith("C") and UCI_CODE.match(line[1]) and line[3] < 0]
    cancellations = documents(cancelled, -1)
    countries = defaultdict(Counter)
    for document in invoices + cancellations:
        countries[document["customer"]][document["country"]] += 1
    customers = [{"id": customer, "country": counter.most_common(1)[0][0]} for customer, counter in sorted(countries.items(), key=lambda entry: int(entry[0]))]
    return {
        "source": {
            "dataset": "Online Retail II",
            "citation": "Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C5CG6D.",
            "licence": "CC BY 4.0",
            "url": "https://archive.ics.uci.edu/dataset/502/online+retail+ii",
            "sha256": digest,
        },
        "rules": RULES["uci"],
        "window": {"first": first_day.isoformat(), "last": last_day.isoformat(), "days": WINDOW_DAYS},
        "counts": {
            "workbookLines": len(lines),
            "windowLines": len(window),
            "saleLinesInWindow": len(sales),
            "eligibleProducts": len(eligible),
            "products": len(products),
            "customers": len(customers),
            "invoices": len(invoices),
            "invoiceLines": sum(len(document["lines"]) for document in invoices),
            "cancellations": len(cancellations),
            "cancellationLines": sum(len(document["lines"]) for document in cancellations),
        },
        "products": products,
        "customers": customers,
        "invoices": invoices,
        "cancellations": cancellations,
    }


# ---------------------------------------------------------------- M5 (CSV)

def extract_m5(folder):
    folder = Path(folder)
    hashes = {name: sha256(folder / name) for name in M5_SHA256}
    wrong = [name for name, expected in M5_SHA256.items() if hashes[name] != expected]
    if wrong:
        fail(f"sha256 differs from the recorded value for {wrong}")
    with open(folder / "calendar.csv", newline="", encoding="utf-8") as handle:
        calendar = {row["d"]: row for row in csv.DictReader(handle)}
    with open(folder / "sales_train_evaluation.csv", newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        expected = ["id", "item_id", "dept_id", "cat_id", "store_id", "state_id"]
        if header[:6] != expected:
            fail(f"sales_train_evaluation.csv header starts {header[:6]}, expected {expected}")
        day_columns = [index for index, name in enumerate(header) if name.startswith("d_")][-WINDOW_DAYS:]
        day_ids = [header[index] for index in day_columns]
        by_department = defaultdict(list)
        for row in reader:
            if row[4] != M5_STORE:
                continue
            daily = [int(row[index]) for index in day_columns]
            if any(quantity < 0 for quantity in daily):
                fail(f"negative units for {row[1]}")
            by_department[row[2]].append({"id": row[1], "department": row[2], "category": row[3], "daily": daily})
    dates = [calendar[day]["date"] for day in day_ids]
    weeks = [calendar[day]["wm_yr_wk"] for day in day_ids]
    items = []
    for department in sorted(by_department):
        rows = sorted(by_department[department], key=lambda item: (-sum(item["daily"]), item["id"]))[:M5_ITEMS_PER_DEPARTMENT]
        items.extend(rows)
    wanted = {item["id"] for item in items}
    week_set = set(weeks)
    prices = defaultdict(dict)
    with open(folder / "sell_prices.csv", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if row["store_id"] == M5_STORE and row["item_id"] in wanted:
                prices[row["item_id"]][row["wm_yr_wk"]] = float(row["sell_price"])
    ordered_weeks = sorted(week_set)
    filled = 0
    for item in items:
        known = prices[item["id"]]
        weekly = {}
        for position, week in enumerate(ordered_weeks):
            if week in known:
                weekly[week] = known[week]
                continue
            earlier = [known[w] for w in sorted(known) if w < week]
            later = [known[w] for w in sorted(known) if w > week]
            if not earlier and not later:
                fail(f"no sell price for {item['id']}")
            weekly[week] = earlier[-1] if earlier else later[0]
            filled += 1
        item["prices"] = [round(weekly[week], 2) for week in weeks]
        item["units"] = sum(item["daily"])
        item["saleDays"] = sum(1 for quantity in item["daily"] if quantity > 0)
    events = {dates[index]: name for index, day in enumerate(day_ids) for name in [calendar[day].get("event_name_1") or ""] if name}
    return {
        "source": {
            "dataset": "M5 Forecasting - Accuracy (Walmart daily unit sales)",
            "citation": "Makridakis, S., Spiliotis, E., Assimakopoulos, V. (2022). M5 accuracy competition: Results, findings, and conclusions. International Journal of Forecasting 38(4), 1346-1364.",
            "terms": "Kaggle's competition rules were not checked; local, non-commercial research use only. Never committed.",
            "sha256": hashes,
        },
        "rules": RULES["m5"],
        "store": M5_STORE,
        "window": {"first": dates[0], "last": dates[-1], "days": WINDOW_DAYS},
        "dates": dates,
        "events": events,
        "counts": {
            "storeItems": sum(len(rows) for rows in by_department.values()),
            "departments": len(by_department),
            "items": len(items),
            "saleLines": sum(item["saleDays"] for item in items),
            "units": sum(item["units"] for item in items),
            "pricesFilledWeeks": filled,
        },
        "items": items,
    }


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--uci", required=True, help="online+retail+ii.zip as downloaded from UCI")
    parser.add_argument("--m5", required=True, help="folder with calendar.csv, sales_train_evaluation.csv and sell_prices.csv")
    parser.add_argument("--out", required=True, help="the JSON file to write (outside the repository)")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    repository = Path(__file__).resolve().parents[2]
    if out == repository or repository in out.parents:
        fail("write the extract outside the repository; it holds public data that is not committed")
    started = datetime.now()
    extract = {
        "schema": SCHEMA,
        "extractedAt": started.isoformat(timespec="seconds"),
        "uci": extract_uci(args.uci),
        "m5": extract_m5(args.m5),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_suffix(out.suffix + ".part")
    temporary.write_text(json.dumps(extract, separators=(",", ":")), encoding="utf-8")
    temporary.replace(out)
    print(json.dumps({"out": str(out), "seconds": round((datetime.now() - started).total_seconds(), 1), "uci": extract["uci"]["counts"], "m5": extract["m5"]["counts"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
