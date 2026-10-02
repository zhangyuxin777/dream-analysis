/**
 * `ObjectStore` 的构建（CLI 与机器人共用）。
 *
 * 放在 oss 层而不是 CLI 里：机器人也要读 OSS（sync 指令），
 * 两边各建一次 store 必然出现"CLI 能连、机器人连不上"这类漂移。
 *
 * 凭据处理：`env.json` 直接给了 AK/SK ⇒ 落成 0600 的 ossutil 配置文件再以 `-c` 传入
 * （**绝不进 argv** —— `ps` 能看到命令行，等于广播 AK）；没给 ⇒ 用 ossutil 自己的配置。
 */
import * as path from 'path';
import { AppConfig } from '../config';
import { ObjectStore } from './store';
import { OssutilStore, materializeOssutilCredentials } from './ossutilStore';

export function buildStore(config: AppConfig): ObjectStore {
  const { accessKeyId, accessKeySecret } = config.oss;
  const configFile = accessKeyId && accessKeySecret
    ? materializeOssutilCredentials({
        filePath: path.join(config.runtime.stateDir, 'ossutil-credentials'),
        endpoint: config.oss.endpoint,
        accessKeyId,
        accessKeySecret,
      })
    : config.oss.configFile || undefined;

  return new OssutilStore({
    binary: config.oss.binary,
    endpoint: config.oss.endpoint,
    bucket: config.oss.bucket,
    configFile,
  });
}
