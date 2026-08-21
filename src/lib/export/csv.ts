import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
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

const encodeCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

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
