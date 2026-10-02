/**
 * 对象存储访问接口（抽象层）。
 *
 * 为什么要有这层：M1 用 `ossutil` CLI 实现（零新依赖、运维能手动复现同一条命令），
 * 将来若换成 `ali-oss` SDK 或要并发/流式下载，只换实现、上层（sync/分析）不动。
 *
 * 注意接口里**没有 head()**：拉取只需 list 的 etag/size/lastModified 就够，
 * 少一个接口就少一份权限要求（`oss:GetObjectMeta` 那条在严格策略里没配通）。
 */

export interface ObjectMeta {
  /** 桶内相对键，如 `snapshot/boye888/2026-10-02.jsonl.gz` */
  key: string;
  size: number;
  etag: string;
  /** 服务端返回的原始时间串（`YYYY-MM-DD HH:mm:ss ±hhmm TZ`） */
  lastModified: string;
  /** 解析出来的毫秒时间戳；解析失败为 null（调用方须容忍） */
  lastModifiedMs: number | null;
}

export interface ObjectStore {
  /** 列出前缀下的对象（递归） */
  list(prefix: string): Promise<ObjectMeta[]>;
  /** 下载单个对象到本地路径（覆盖写；父目录由调用方保证） */
  getTo(key: string, destPath: string): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    public readonly kind: 'list' | 'download' | 'config',
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}
