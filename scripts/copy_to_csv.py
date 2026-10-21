"""Converte os blocos COPY de um dump do Postgres em um CSV por tabela (abre no Excel).

Uso: python3 copy_to_csv.py <data.sql> <pasta-de-saida>
"""

import csv
import re
import sys
from pathlib import Path

HEADER = re.compile(r'^COPY "?(\w+)"?\."?(\w+)"? \((.*)\) FROM stdin;$')
ESCAPES = {"t": "\t", "n": "\n", "r": "\r", "\\": "\\"}


def unescape(value: str) -> str:
    if value == r"\N":
        return ""
    out, i = [], 0
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            out.append(ESCAPES.get(value[i + 1], value[i + 1]))
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def main(src: str, outdir: str) -> None:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    writer = None
    handle = None
    table = ""
    rows = 0
    for raw in Path(src).read_text(encoding="utf-8").splitlines():
        match = HEADER.match(raw)
        if match:
            schema, table, cols = match.groups()
            table = f"{schema}.{table}"
            # utf-8-sig: o Excel reconhece os acentos
            handle = open(out / f"{table}.csv", "w", newline="", encoding="utf-8-sig")
            writer = csv.writer(handle, delimiter=";")
            writer.writerow([c.strip().strip('"') for c in cols.split(", ")])
            rows = 0
        elif writer is not None and raw == r"\.":
            handle.close()
            print(f"{table}: {rows} linha(s)")
            writer = handle = None
        elif writer is not None:
            writer.writerow([unescape(v) for v in raw.split("\t")])
            rows += 1


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
