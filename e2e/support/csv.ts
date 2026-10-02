/** A minimal CSV reader for the export specs (quoted cells, doubled quotes, line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
    const out: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(cell);
            cell = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') {
                index += 1;
            }

            row.push(cell);
            out.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }

    if (cell !== '' || row.length > 0) {
        row.push(cell);
        out.push(row);
    }

    return out;
}

/** The rows of a CSV as objects keyed by the header. */
export function csvRecords(text: string): Record<string, string>[] {
    const [header, ...body] = parseCsv(text);

    return body.map((cells) =>
        Object.fromEntries(
            header.map((name, index) => [name, cells[index] ?? '']),
        ),
    );
}
