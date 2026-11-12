"""Converte um .xlsx na grade que a leitura da planilha de Educação usa (a mesma forma da Google Sheets API).

    python3 scripts/xlsx-to-grid.py planilha.xlsx saida.json

Precisa do openpyxl. Para cada aba: valores (o último cálculo salvo no arquivo) e fórmulas. Datas viram texto ISO.
A planilha tem valores do negócio: guarde a saída fora do repositório.
"""
import datetime
import json
import sys

import openpyxl


def cell(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()[:10]
    if isinstance(v, (int, float, bool)) or v is None:
        return v
    return str(v)


def main(src, dst):
    formulas = openpyxl.load_workbook(src, data_only=False)
    values = openpyxl.load_workbook(src, data_only=True)
    tabs = []
    for ws in formulas.worksheets:
        wv = values[ws.title]
        rows = range(1, ws.max_row + 1)
        cols = range(1, ws.max_column + 1)
        tabs.append({
            "title": ws.title,
            "values": [[cell(wv.cell(r, c).value) for c in cols] for r in rows],
            "formulas": [[cell(ws.cell(r, c).value) for c in cols] for r in rows],
        })
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"tabs": tabs}, f, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
