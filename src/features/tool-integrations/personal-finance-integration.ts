/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added PersonalFinanceIntegrationService for persisted import, analysis, and reporting
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'personal-finance-integration' });

const DEFAULT_CURRENCY = 'USD';

/**
 * @description Configuration that scopes the finance integration to a single agent and its on-disk ledger, and supplies optional budgeting, alerting, lookback, and savings parameters used during analysis and reporting.
 */
export interface PersonalFinanceConfig {
  agentId: string;
  storageDir: string;
  budgetTargets?: Record<string, number>;
  alertThreshold?: number;
  lookbackDays?: number;
  savingsGoal?: number;
}

/**
 * @description Normalized representation of a single ledger transaction, providing a stable shape across heterogeneous import sources so transactions can be deduplicated, persisted, and analyzed consistently.
 */
export interface FinanceTransaction {
  id: string;
  date: string;
  description: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  source: string;
  account?: string;
  raw?: Record<string, unknown>;
}

/**
 * @description Input contract for importing transactions, allowing inline raw records and/or file paths to be ingested together under an optional source label.
 */
export interface FinanceImportRequest {
  transactions?: Record<string, unknown>[];
  filePaths?: string[];
  source?: string;
}

/**
 * @description Optional filters for a spending analysis, narrowing the ledger by category and overriding the configured lookback window and unusual-transaction alert threshold.
 */
export interface FinanceAnalysisRequest {
  category?: string;
  lookbackDays?: number;
  alertThreshold?: number;
}

/**
 * @description Extends the analysis filters with reporting-specific options for the rendered report title and an optional file path to persist the generated Markdown.
 */
export interface FinanceReportRequest extends FinanceAnalysisRequest {
  title?: string;
  outputPath?: string;
}

/**
 * @description Service that manages an agent's persisted personal finance ledger, providing import (with deduplication), spending analysis, budget checking, and Markdown report generation backed by a JSON file in the configured storage directory.
 */
export class PersonalFinanceIntegrationService {
  /**
   * @description Creates the service bound to a specific agent configuration that determines storage location, budgets, and analysis defaults.
   * @param config Configuration scoping the service to an agent and its ledger storage plus optional budgeting/analysis defaults.
   */
  constructor(private readonly config: PersonalFinanceConfig) {}

  /**
   * @description Ingests inline and/or file-based transactions, normalizes them, merges them into the existing ledger by id to avoid duplicates, persists the result sorted by most recent date, and logs the outcome.
   * @param request The transactions, file paths, and optional source label to import.
   * @returns The count of incoming transactions, the total ledger size after merge, and the distinct sources imported.
   */

  importTransactions(request: FinanceImportRequest): {
    importedCount: number;
    totalTransactions: number;
    sources: string[];
  } {
    const incoming: FinanceTransaction[] = [];

    for (const transaction of request.transactions || []) {
      incoming.push(this.normalizeTransaction(transaction, request.source || 'manual-input'));
    }

    for (const filePath of request.filePaths || []) {
      incoming.push(...this.loadTransactionsFromFile(filePath, request.source));
    }

    const ledger = this.readLedger();
    const merged = new Map<string, FinanceTransaction>();

    for (const transaction of [...ledger, ...incoming]) {
      merged.set(transaction.id, transaction);
    }

    const updated = Array.from(merged.values()).sort((left, right) => right.date.localeCompare(left.date));
    this.writeLedger(updated);

    logger.info(
      { agentId: this.config.agentId, importedCount: incoming.length, totalTransactions: updated.length },
      'Imported personal finance transactions',
    );

    return {
      importedCount: incoming.length,
      totalTransactions: updated.length,
      sources: Array.from(new Set(incoming.map((transaction) => transaction.source))).sort(),
    };
  }

  /**
   * @description Computes a spending summary over the filtered ledger, aggregating totals by category, merchant, and month, evaluating per-category budget status, and flagging unusual and recurring spending.
   * @param request Optional filters and overrides for category, lookback window, and alert threshold.
   * @returns A structured analysis including totals, category/merchant/month breakdowns, budget status, unusual transactions, recurring merchants, and savings goal.
   */
  analyzeSpending(request: FinanceAnalysisRequest = {}): Record<string, unknown> {
    const ledger = this.filterLedger(request);
    const categoryTotals = new Map<string, number>();
    const merchantTotals = new Map<string, number>();
    const monthTotals = new Map<string, number>();

    let totalSpend = 0;

    for (const transaction of ledger) {
      totalSpend += transaction.amount;
      categoryTotals.set(transaction.category, (categoryTotals.get(transaction.category) || 0) + transaction.amount);
      merchantTotals.set(transaction.merchant, (merchantTotals.get(transaction.merchant) || 0) + transaction.amount);
      monthTotals.set(transaction.date.slice(0, 7), (monthTotals.get(transaction.date.slice(0, 7)) || 0) + transaction.amount);
    }

    const budgets = this.config.budgetTargets || {};
    const budgetStatus = Array.from(categoryTotals.entries())
      .map(([category, spent]) => ({
        category,
        spent: roundMoney(spent),
        budget: budgets[category] ?? null,
        variance: budgets[category] !== undefined ? roundMoney(spent - budgets[category]) : null,
        status: budgets[category] !== undefined
          ? spent > budgets[category] ? 'over' : 'within'
          : 'untracked',
      }))
      .sort((left, right) => right.spent - left.spent);

    const unusualTransactions = ledger
      .filter((transaction) => transaction.amount >= (request.alertThreshold ?? this.config.alertThreshold ?? 500))
      .slice(0, 10);

    const recurringMerchants = Array.from(groupBy(ledger, (transaction) => transaction.merchant).entries())
      .map(([merchant, transactions]) => ({
        merchant,
        transactionCount: transactions.length,
        totalSpent: roundMoney(transactions.reduce((sum, transaction) => sum + transaction.amount, 0)),
      }))
      .filter((merchant) => merchant.transactionCount >= 3)
      .sort((left, right) => right.totalSpent - left.totalSpent)
      .slice(0, 10);

    return {
      agentId: this.config.agentId,
      generatedAt: new Date().toISOString(),
      transactionCount: ledger.length,
      lookbackDays: request.lookbackDays ?? this.config.lookbackDays ?? 90,
      totalSpend: roundMoney(totalSpend),
      categoryTotals: mapToSortedMoneyArray(categoryTotals),
      topMerchants: mapToSortedMoneyArray(merchantTotals).slice(0, 10),
      monthlyTotals: mapToSortedMoneyArray(monthTotals),
      budgetStatus,
      unusualTransactions,
      recurringMerchants,
      savingsGoal: this.config.savingsGoal ?? null,
    };
  }

  /**
   * @description Runs a spending analysis and renders it as a Markdown report, optionally writing the report to the requested output path (creating parent directories as needed).
   * @param request Analysis filters plus optional report title and output path.
   * @returns The rendered Markdown, the underlying analysis, and the report path when written to disk.
   */
  generateReport(request: FinanceReportRequest = {}): {
    reportPath?: string;
    reportMarkdown: string;
    analysis: Record<string, unknown>;
  } {
    const analysis = this.analyzeSpending(request);
    const reportMarkdown = this.renderMarkdownReport(request.title || 'Personal Finance Report', analysis);

    if (!request.outputPath) {
      return { reportMarkdown, analysis };
    }

    fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
    fs.writeFileSync(request.outputPath, reportMarkdown, 'utf8');

    return {
      reportPath: request.outputPath,
      reportMarkdown,
      analysis,
    };
  }

  /**
   * @description Produces a budget-focused snapshot by running a spending analysis and returning only the budget-relevant fields for quick budget compliance checks.
   * @param request Optional filters and overrides for category, lookback window, and alert threshold.
   * @returns A subset of the analysis containing generation time, transaction count, per-category budget status, total spend, and savings goal.
   */
  checkBudget(request: FinanceAnalysisRequest = {}): Record<string, unknown> {
    const analysis = this.analyzeSpending(request);
    return {
      generatedAt: analysis.generatedAt,
      transactionCount: analysis.transactionCount,
      budgetStatus: analysis.budgetStatus,
      totalSpend: analysis.totalSpend,
      savingsGoal: analysis.savingsGoal,
    };
  }

  private filterLedger(request: FinanceAnalysisRequest): FinanceTransaction[] {
    const lookbackDays = request.lookbackDays ?? this.config.lookbackDays ?? 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    return this.readLedger()
      .filter((transaction) => transaction.date >= cutoffIso)
      .filter((transaction) => !request.category || transaction.category === request.category);
  }

  private readLedger(): FinanceTransaction[] {
    const ledgerPath = this.getLedgerPath();
    if (!fs.existsSync(ledgerPath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as FinanceTransaction[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      logger.error({ err: error, ledgerPath }, 'Failed to read finance ledger; returning empty ledger');
      return [];
    }
  }

  private writeLedger(transactions: FinanceTransaction[]): void {
    fs.mkdirSync(this.config.storageDir, { recursive: true });
    fs.writeFileSync(this.getLedgerPath(), JSON.stringify(transactions, null, 2), 'utf8');
  }

  private getLedgerPath(): string {
    return path.join(this.config.storageDir, 'transactions.json');
  }

  private loadTransactionsFromFile(filePath: string, source?: string): FinanceTransaction[] {
    const extension = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf8');

    if (extension === '.json') {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Finance import JSON file "${filePath}" must contain an array of transactions.`);
      }
      return parsed.map((entry) => this.normalizeTransaction(entry as Record<string, unknown>, source || path.basename(filePath)));
    }

    if (extension === '.csv') {
      return parseCsv(content)
        .map((entry) => this.normalizeTransaction(entry, source || path.basename(filePath)));
    }

    throw new Error(`Unsupported finance import file type "${extension}" for "${filePath}".`);
  }

  private normalizeTransaction(
    raw: Record<string, unknown>,
    source: string,
  ): FinanceTransaction {
    const date = normalizeDate(String(firstDefined(raw.date, raw.transactionDate, raw.postedDate, raw.Date) || ''));
    const description = String(firstDefined(raw.description, raw.memo, raw.Description, raw.name, raw.title) || '').trim();
    const merchant = String(firstDefined(raw.merchant, raw.payee, raw.Merchant, raw.Description, raw.description) || description || 'Unknown Merchant').trim();
    const amount = normalizeAmount(firstDefined(raw.amount, raw.Amount, raw.debit, raw.credit, raw.total));
    const category = String(firstDefined(raw.category, raw.Category) || categorizeTransaction(description, merchant)).trim();
    const account = firstDefined(raw.account, raw.Account, raw.account_name);
    const idSeed = JSON.stringify([date, merchant, amount, category, source, account || '']);

    return {
      id: String(firstDefined(raw.id, raw.transactionId, raw.transaction_id) || hashText(idSeed)),
      date,
      description: description || merchant,
      merchant,
      amount,
      currency: String(firstDefined(raw.currency, raw.Currency) || DEFAULT_CURRENCY),
      category,
      source,
      account: account ? String(account) : undefined,
      raw,
    };
  }

  private renderMarkdownReport(title: string, analysis: Record<string, unknown>): string {
    const categoryTotals = Array.isArray(analysis.categoryTotals) ? analysis.categoryTotals as Array<{ name: string; amount: number }> : [];
    const topMerchants = Array.isArray(analysis.topMerchants) ? analysis.topMerchants as Array<{ name: string; amount: number }> : [];
    const budgetStatus = Array.isArray(analysis.budgetStatus) ? analysis.budgetStatus as Array<{ category: string; spent: number; budget: number | null; variance: number | null; status: string }> : [];
    const unusualTransactions = Array.isArray(analysis.unusualTransactions) ? analysis.unusualTransactions as FinanceTransaction[] : [];

    const lines = [
      `# ${title}`,
      '',
      `Generated: ${analysis.generatedAt as string}`,
      `Transactions analyzed: ${analysis.transactionCount as number}`,
      `Total spend: $${Number(analysis.totalSpend || 0).toFixed(2)}`,
      '',
      '## Category Breakdown',
      ...categoryTotals.map((entry) => `- ${entry.name}: $${entry.amount.toFixed(2)}`),
      '',
      '## Top Merchants',
      ...topMerchants.map((entry) => `- ${entry.name}: $${entry.amount.toFixed(2)}`),
      '',
      '## Budget Status',
      ...budgetStatus.map((entry) => `- ${entry.category}: $${entry.spent.toFixed(2)} spent${entry.budget !== null ? ` vs $${entry.budget.toFixed(2)} budget (${entry.status})` : ''}`),
      '',
      '## Unusual Transactions',
      ...(unusualTransactions.length > 0
        ? unusualTransactions.map((transaction) => `- ${transaction.date} | ${transaction.merchant} | $${transaction.amount.toFixed(2)} | ${transaction.category}`)
        : ['- None flagged in the current lookback window.']),
    ];

    return lines.join('\n').trimEnd() + '\n';
  }
}

function parseCsv(content: string): Record<string, unknown>[] {
  const rows = splitCsvLines(content);
  if (rows.length === 0) {
    return [];
  }

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((value) => value.trim());

  return dataRows
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => {
      const record: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        record[header] = row[index] ?? '';
      });
      return record;
    });
}

function splitCsvLines(content: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = index + 1 < content.length ? content[index + 1] : '';

    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === ',') {
      row.push(current);
      current = '';
      continue;
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  return rows;
}

function firstDefined<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value);
  }

  const normalized = String(value ?? '')
    .replaceAll(/[$,]/g, '')
    .trim();

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.abs(parsed);
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return parsed.toISOString().slice(0, 10);
}

function categorizeTransaction(description: string, merchant: string): string {
  const value = `${description} ${merchant}`.toLowerCase();

  if (/(rent|mortgage|utility|electric|water|internet)/.test(value)) return 'housing';
  if (/(grocery|market|restaurant|coffee|food|ubereats|doordash)/.test(value)) return 'food_dining';
  if (/(amazon|walmart|target|best buy|retail|shop)/.test(value)) return 'shopping';
  if (/(gas|fuel|uber|lyft|transit|parking|car )/.test(value)) return 'transportation';
  if (/(movie|concert|spotify|netflix|entertainment|hobby|game)/.test(value)) return 'entertainment';
  if (/(pharmacy|hospital|doctor|health|medical|dentist)/.test(value)) return 'healthcare';
  if (/(bank|fee|interest|loan|investment|insurance|credit)/.test(value)) return 'financial';
  return 'other';
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return `txn_${Math.abs(hash)}`;
}

function groupBy<T>(items: T[], selectKey: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = selectKey(item);
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  }
  return grouped;
}

function mapToSortedMoneyArray(values: Map<string, number>): Array<{ name: string; amount: number }> {
  return Array.from(values.entries())
    .map(([name, amount]) => ({ name, amount: roundMoney(amount) }))
    .sort((left, right) => right.amount - left.amount);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
