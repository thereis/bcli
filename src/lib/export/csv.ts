import { once } from 'node:events';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'csv-parse';

export const obscure = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  const visibleLocal = local.slice(0, 2);
  const visibleDomain = domain.slice(0, 2);
  return `${visibleLocal}${'*'.repeat(Math.max(0, local.length - 2))}@${visibleDomain}${'*'.repeat(Math.max(0, domain.length - 2))}`;
};

export const readCsvColumnValues = (
  filePath: string,
  column: string,
): Promise<Set<string>> => {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) return resolve(new Set());
    const values = new Set<string>();
    createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true }))
      .on('data', (row: Record<string, string>) => {
        const val = row[column];
        if (val) values.add(val);
      })
      .on('end', () => resolve(values))
      .on('error', reject);
  });
};

export const readCsvRows = (
  filePath: string,
): Promise<Record<string, string>[]> => {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) return resolve([]);
    const rows: Record<string, string>[] = [];
    createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
      .on('data', (row: Record<string, string>) => {
        rows.push(row);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
};

export const appendCsvRow = (filePath: string, row: Record<string, string>) => {
  const values = Object.values(row).map((v) => `"${v.replace(/"/g, '""')}"`);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    const headerLine = Object.keys(row)
      .map((k) => `"${k}"`)
      .join(',');
    writeFileSync(filePath, `${headerLine}\n`);
  }
  appendFileSync(filePath, `${values.join(',')}\n`);
};

export const encodeCsvCell = (value: string) =>
  `"${value.replace(/"/g, '""')}"`;

export const writeCsvFileAtomic = (
  filePath: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
) => {
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new Error(
        `CSV row ${index + 1} has ${row.length} values, expected ${headers.length}.`,
      );
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const lines = [
    headers.map(encodeCsvCell).join(','),
    ...rows.map((row) => row.map(encodeCsvCell).join(',')),
  ];

  try {
    writeFileSync(temporaryPath, `${lines.join('\n')}\n`);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};

const assertRowWidth = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
) => {
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new Error(
        `CSV row ${index + 1} has ${row.length} values, expected ${headers.length}.`,
      );
    }
  }
};

export const appendCsvRows = (
  filePath: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
) => {
  assertRowWidth(headers, rows);
  mkdirSync(dirname(filePath), { recursive: true });
  const lines: string[] = [];
  if (!existsSync(filePath)) {
    lines.push(`${headers.map(encodeCsvCell).join(',')}\n`);
  }
  for (const row of rows) {
    lines.push(`${row.map(encodeCsvCell).join(',')}\n`);
  }
  if (lines.length > 0) appendFileSync(filePath, lines.join(''));
};

const headerByteLength = (filePath: string) => {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, read).indexOf(10);
    if (newline === -1) {
      throw new Error(`CSV file "${filePath}" has no header line.`);
    }
    return newline + 1;
  } finally {
    closeSync(fd);
  }
};

export const mergeCsvFiles = async (
  parts: readonly string[],
  outputFile: string,
) => {
  const present = parts.filter((part) => existsSync(part));
  if (present.length === 0) {
    throw new Error('No CSV parts to merge.');
  }
  mkdirSync(dirname(outputFile), { recursive: true });
  const temporaryPath = `${outputFile}.tmp-${process.pid}`;
  const output = createWriteStream(temporaryPath);
  output.on('error', () => {});
  try {
    for (const [index, part] of present.entries()) {
      const start = index === 0 ? 0 : headerByteLength(part);
      const input = createReadStream(part, { start });
      for await (const chunk of input) {
        if (!output.write(chunk)) await once(output, 'drain');
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    renameSync(temporaryPath, outputFile);
  } catch (error) {
    output.destroy();
    await once(output, 'close').catch(() => undefined);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};
