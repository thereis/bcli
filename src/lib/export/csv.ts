import { parse } from 'csv-parse';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';

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

export const appendCsvRow = (filePath: string, row: Record<string, string>) => {
  const values = Object.values(row).map((v) => `"${v.replace(/"/g, '""')}"`);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    const headerLine = Object.keys(row)
      .map((k) => `"${k}"`)
      .join(',');
    writeFileSync(filePath, headerLine + '\n');
  }
  appendFileSync(filePath, values.join(',') + '\n');
};
