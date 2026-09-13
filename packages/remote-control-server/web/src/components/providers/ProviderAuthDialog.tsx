import { useEffect, useMemo, useState } from 'react';
import {
  apiBeginProviderAuth,
  apiBeginProviderSecret,
  apiCancelProviderAuth,
  apiFetchProviderAuthStatus,
  apiFetchProviderOperation,
  apiRefreshProviderAuth,
  apiSubmitProviderSecret,
  apiSubmitProviderAuthCode,
} from '../../api/client';
import {
  ProviderAuthModel,
  PROVIDER_AUTH_ERROR_TEXT,
  type BrowserProviderAuthStatus,
} from '../../lib/provider-auth-model';
import { awaitPendingProviderValue } from '../../lib/provider-pending';
import { encryptProviderSecret, parseProviderSecretChallenge } from '../../lib/provider-secret';
import { generateMessageUuid } from '../../lib/utils';
import type { ProviderCatalogProfile, ProviderCatalogResponse } from '../../types';

export function ProviderAuthDialog({
  environmentId,
  provider,
  onClose,
  onChanged,
}: {
  environmentId: string;
  provider: ProviderCatalogProfile | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const model = useMemo(() => new ProviderAuthModel(), []);
  const [status, setStatus] = useState<BrowserProviderAuthStatus | null>(null);
  const [code, setCode] = useState('');
  const [secretMethod, setSecretMethod] = useState<string | null>(null);
  const [credential, setCredential] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretSaved, setSecretSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!provider || !status || !['starting', 'waiting'].includes(status.state)) return;
    const timer = setTimeout(() => {
      void apiFetchProviderAuthStatus(environmentId, status.operationId)
        .then(response => {
          // A status read that times out falls back to the cached catalog with
          // no `value`. That is a transient miss, not a dead operation — keep
          // the last known status and let the next tick retry, instead of
          // tearing the dialog down mid device-flow.
          if (response.value === undefined) return;
          const next = model.apply(response);
          setStatus(next);
          if (next.state === 'succeeded') void onChanged();
        })
        .catch(reason => setError(authErrorText(reason)));
    }, model.pollDelay());
    return () => clearTimeout(timer);
  }, [environmentId, model, onChanged, provider, status]);
  if (!provider) return null;
  const begin = (method: string) => {
    const operationId = generateMessageUuid();
    setError(null);
    // The begin handshake is a write, so a Worker slower than the server's
    // ~1.5s synchronous window answers 202 with no `value`. Feeding that body
    // straight to model.apply() threw invalid_provider_auth_status and left
    // `status` null, so the polling effect never started — the device flow was
    // running on the Worker while the panel showed only an error. Collect the
    // durable result instead.
    void apiBeginProviderAuth(environmentId, provider.id, { operation_id: operationId, method })
      .then(response => awaitPendingProviderValue(environmentId, operationId, response))
      .then(value => setStatus(model.applyValue(value)))
      .catch(reason => setError(authErrorText(reason)));
  };
  const close = () => {
    if (status && ['starting', 'waiting'].includes(status.state))
      void apiCancelProviderAuth(environmentId, status.operationId);
    setStatus(null);
    setCode('');
    setCredential('');
    setSecretMethod(null);
    setSecretSaved(false);
    onClose();
  };
  const saveSecret = async () => {
    if (!secretMethod) return;
    const value = credential;
    setSecretBusy(true);
    setError(null);
    try {
      const operationId = generateMessageUuid();
      const response = await apiBeginProviderSecret(environmentId, provider.id, {
        operation_id: operationId,
        method: secretMethod,
      });
      const challenge = parseProviderSecretChallenge(await awaitSecretChallenge(environmentId, operationId, response));
      if (challenge.operationId !== operationId || challenge.expiresAt <= Date.now()) {
        throw new Error('一次性加密通道已失效，请重试');
      }
      const envelope = await encryptProviderSecret(challenge, value);
      await apiSubmitProviderSecret(environmentId, provider.id, {
        operation_id: operationId,
        method: secretMethod,
        envelope,
      });
      // Clear only once the credential is actually on the Worker. Clearing up
      // front meant any failure left an empty input behind, so every retry
      // encrypted an empty string and died locally — the request never even
      // left the browser, and the key could never be saved again.
      setCredential('');
      setSecretMethod(null);
      setSecretSaved(true);
      await onChanged();
    } catch (reason) {
      setError(secretErrorText(reason));
    } finally {
      setSecretBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface-2 p-5 shadow-xl">
        <h2 className="text-lg font-medium">认证 {provider.displayName}</h2>
        {!status && !secretMethod && !secretSaved && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {authMethods(provider).map(method => (
              <button
                key={method.id}
                type="button"
                onClick={() =>
                  method.action
                    ? void refresh(environmentId, provider.id, method.action, onChanged, setError)
                    : method.secret
                      ? setSecretMethod(method.id)
                      : begin(method.id)
                }
                className="rounded-lg border border-border p-3 text-left hover:bg-surface-1"
              >
                <span className="block text-xs font-medium">{method.label}</span>
                <span className="mt-1 block text-[10px] text-text-muted">{method.description}</span>
              </button>
            ))}
          </div>
        )}
        {secretMethod && (
          <div className="mt-4 rounded-lg border border-border bg-surface-1 p-4 text-xs">
            <p className="font-medium">{secretMethod === 'bearer-token' ? 'Bearer Token' : 'API Key'}</p>
            <p className="mt-1 text-[10px] text-text-muted">
              浏览器会直接为本地 Worker 加密；远程服务只短暂中转一次性密文，不写入数据库。
            </p>
            <input
              type="password"
              value={credential}
              onChange={event => setCredential(event.target.value)}
              placeholder="输入凭据"
              autoComplete="off"
              spellCheck={false}
              maxLength={16 * 1024}
              className="mt-3 w-full rounded-md border border-border bg-surface-2 px-2 py-2 font-mono"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={secretBusy}
                onClick={() => {
                  setCredential('');
                  setSecretMethod(null);
                }}
                className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
              >
                返回
              </button>
              <button
                type="button"
                disabled={secretBusy || !credential.trim()}
                onClick={() => void saveSecret()}
                className="rounded-md bg-brand px-3 py-1.5 text-white disabled:opacity-40"
              >
                {secretBusy ? '正在加密并保存…' : '加密并保存'}
              </button>
            </div>
          </div>
        )}
        {secretSaved && (
          <p className="mt-4 rounded-lg border border-border bg-surface-1 p-4 text-xs text-status-success">
            凭据已保存到本地 Worker。
          </p>
        )}
        {status && (
          <div className="mt-4 rounded-lg border border-border bg-surface-1 p-4 text-xs">
            <p>状态：{statusLabel(status.state)}</p>
            {status.authorizationUrl && (
              <p className="mt-2 break-all">
                <a className="text-brand underline" href={status.authorizationUrl} target="_blank" rel="noreferrer">
                  打开本地 Worker 提供的授权页面
                </a>
              </p>
            )}
            {status.userCode && (
              <p className="mt-3">
                用户码：<strong className="font-mono text-base">{status.userCode}</strong>
              </p>
            )}
            {status.authorizationUrl && !status.userCode && status.state === 'waiting' && (
              <div className="mt-3 flex gap-2">
                <input
                  value={code}
                  onChange={event => setCode(event.target.value)}
                  placeholder="粘贴 authorizationCode#state"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5"
                />
                <button
                  type="button"
                  onClick={() =>
                    void apiSubmitProviderAuthCode(environmentId, status.operationId, code)
                      .then(response => awaitPendingProviderValue(environmentId, status.operationId, response))
                      .then(value => setStatus(model.applyValue(value)))
                      .catch(reason => setError(authErrorText(reason)))
                  }
                  className="rounded-md bg-brand px-3 py-1.5 text-white"
                >
                  提交
                </button>
              </div>
            )}
            {model.errorText() && <p className="mt-3 text-status-error">{model.errorText()}</p>}
          </div>
        )}
        {error && <p className="mt-3 text-xs text-status-error">{error}</p>}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={close} className="rounded-md border border-border px-3 py-2 text-xs">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Resolve the one-time encryption challenge from a begin handshake.
 *
 * Thin wrapper over the shared pending-write poll: the handshake is a write, so
 * a Worker slower than the server's synchronous window answers 202 with no
 * `value` and the challenge only lands in the durable command result.
 */
export async function awaitSecretChallenge(
  environmentId: string,
  operationId: string,
  response: ProviderCatalogResponse,
  fetchOperation: typeof apiFetchProviderOperation = apiFetchProviderOperation,
  pollIntervalMs?: number,
): Promise<unknown> {
  try {
    return await awaitPendingProviderValue(environmentId, operationId, response, fetchOperation, pollIntervalMs);
  } catch (reason) {
    if (reason instanceof Error && reason.message === 'provider_operation_pending_timeout')
      throw new Error('本地 Worker 未在超时前建立加密通道，请确认它在线后重试');
    throw reason;
  }
}

const SECRET_ERROR_TEXT: Record<string, string> = {
  invalid_provider_secret: '凭据为空，请重新粘贴后再保存',
  invalid_provider_secret_challenge: '本地 Worker 返回的加密通道无效，请重试',
  provider_secret_decryption_failed: '本地 Worker 无法解密该凭据，请重试',
  provider_secret_operation_not_found: '加密通道已过期，请重试',
  environment_offline: '本地 Worker 不在线，无法保存凭据',
};

function secretErrorText(reason: unknown): string {
  if (!(reason instanceof Error)) return '凭据保存失败';
  return SECRET_ERROR_TEXT[reason.message] ?? reason.message;
}

/** Map a thrown auth-flow error to copy, keeping the raw code when unmapped. */
function authErrorText(reason: unknown): string {
  if (!(reason instanceof Error)) return '认证启动失败';
  return PROVIDER_AUTH_ERROR_TEXT[reason.message] ?? reason.message;
}

type AuthMethodOption = {
  id: string;
  label: string;
  description: string;
  action?: string;
  secret?: boolean;
};

function authMethods(provider: ProviderCatalogProfile): AuthMethodOption[] {
  if (provider.auth.scheme === 'oauth' && (provider.kind === 'anthropic' || provider.kind === 'anthropic-compatible'))
    return [
      { id: 'claude-subscription-oauth', label: 'Claude 订阅 OAuth', description: 'Claude Pro / Max 账号' },
      { id: 'anthropic-console-oauth', label: 'Anthropic Console OAuth', description: 'API 用量计费账号' },
    ];
  if (provider.kind === 'chatgpt')
    return [
      {
        id: 'chatgpt-import',
        label: '从 Codex 导入',
        description: '复用本机已有的 ChatGPT 订阅登录',
      },
      { id: 'chatgpt-device-oauth', label: 'ChatGPT Device Flow', description: '显示验证网址和用户码' },
    ];
  if (provider.auth.scheme === 'aws-iam')
    return [{ id: 'aws-iam', action: 'aws-refresh', label: '刷新 AWS IAM', description: '重新检测本地凭据链' }];
  if (provider.auth.scheme === 'gcp-adc')
    return [
      {
        id: 'gcp-adc',
        action: 'gcp-refresh',
        label: '刷新 GCP ADC',
        description: '重新检测 Application Default Credentials',
      },
    ];
  if (provider.auth.scheme === 'azure-ad')
    return [
      {
        id: 'azure-ad',
        action: 'azure-refresh',
        label: '刷新 Azure AD',
        description: '重新检测 DefaultAzureCredential',
      },
    ];
  if (provider.auth.scheme === 'proxy')
    return [
      {
        id: 'proxy',
        action: 'proxy-probe',
        label: '检测本地代理',
        description: '重新检测 Worker 上的代理认证配置',
      },
    ];
  return [
    {
      id: provider.auth.scheme === 'bearer' ? 'bearer-token' : 'api-key',
      label: provider.auth.scheme === 'bearer' ? '配置 Bearer Token' : '配置 API Key',
      description: '使用端到端加密的一次性凭据通道',
      secret: true,
    },
  ];
}

async function refresh(
  environmentId: string,
  providerId: string,
  action: string,
  onChanged: () => void | Promise<void>,
  setError: (value: string | null) => void,
) {
  try {
    await apiRefreshProviderAuth(environmentId, providerId, { operation_id: generateMessageUuid(), action });
    await onChanged();
  } catch (error) {
    setError(error instanceof Error ? error.message : '凭据刷新失败');
  }
}

function statusLabel(state: BrowserProviderAuthStatus['state']): string {
  return {
    starting: '正在启动',
    waiting: '等待用户完成',
    succeeded: '认证成功',
    failed: '认证失败',
    cancelled: '已取消',
    expired: '已过期',
  }[state];
}
