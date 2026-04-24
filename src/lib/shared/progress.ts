import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import type { ProgressState } from '../bigcommerce/schemas.ts';

export const loadProgress = (path: string): ProgressState | null => {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ProgressState;
};

export const saveProgress = (path: string, state: ProgressState) => {
  writeFileSync(path, JSON.stringify(state));
};

export const removeProgress = (path: string) => {
  if (existsSync(path)) unlinkSync(path);
};
