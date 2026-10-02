/**
 * 结果渲染（markdown）+ 长度预算。
 *
 * 为什么要长度预算：机器人单条消息有上限（钉钉/飞书都是），超了要么被截断得莫名其妙、
 * 要么发送失败。这里的策略是**保头部**：标题 / 摘要 / 告警 / 暂定标记一定保留，
 * 表格按顺序塞行，塞不下就停并明确写「本节仅显示前 K 行 / 共 N 行」+ 末尾「已截断」。
 * 不做"按重要性挑行"的花活 —— 那种策略没法解释，出问题也难查。
 */
import { AnalysisResult, Section } from '../analysis/types';

export interface RenderOptions {
  maxChars?: number;
}

export interface RenderOutput {
  text: string;
  truncated: boolean;
}

export const DEFAULT_MAX_CHARS = 3500;

export function renderSection(section: Section): string {
  const lines: string[] = [`### ${section.heading}`];
  if (section.note) lines.push(`> ${section.note}`);
  if (section.headers && section.headers.length > 0) {
    lines.push(`| ${section.headers.join(' | ')} |`);
    lines.push(`| ${section.headers.map(() => '---').join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderRow(section: Section, row: string[]): string {
  return section.headers && section.headers.length > 0 ? `| ${row.join(' | ')} |` : row.join('  ');
}

export function renderResult(result: AnalysisResult, opts: RenderOptions = {}): RenderOutput {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const head: string[] = [`## ${result.title}`];
  if (result.provisional) head.push('> ⚠️ **暂定**：窗口里含未封存（final=false）的数据，结论仅供参考');
  head.push(result.summary);
  for (const warning of result.warnings) head.push(`- ⚠️ ${warning}`);

  let text = head.join('\n');
  let truncated = false;

  for (const section of result.sections ?? []) {
    const blockHeader = renderSection(section);
    const rows: string[] = [];
    for (const row of section.rows) {
      const candidate = [...rows, renderRow(section, row)].join('\n');
      if (`${text}\n\n${blockHeader}\n${candidate}`.length > maxChars) {
        truncated = true;
        break;
      }
      rows.push(renderRow(section, row));
    }

    if (rows.length === 0 && section.rows.length > 0) {
      truncated = true;
      continue; // 这一节整块放不下 ⇒ 跳过（但记 truncated）
    }

    const parts = [blockHeader, ...rows];
    if (rows.length < section.rows.length) parts.push(`…（本节仅显示前 ${rows.length} 行 / 共 ${section.rows.length} 行）`);
    text = `${text}\n\n${parts.join('\n')}`;
  }

  if (truncated) text += '\n\n…（已截断，完整内容可落盘成文件）';
  return { text, truncated };
}
