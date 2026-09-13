import { Archive, CheckCircle2, KeyRound, ListChecks, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { ProviderCatalogProfile } from '../../types';

export function ProviderCard({
  provider,
  defaultModelId,
  disabled,
  onEdit,
  onArchive,
  onDelete,
  onManageModels,
  onAddModel,
  onEditModel,
  onArchiveModel,
  onDeleteModel,
  onSetDefault,
  onValidate,
  onAuthenticate,
}: {
  provider: ProviderCatalogProfile;
  defaultModelId: string | null;
  disabled: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onManageModels: () => void;
  onAddModel: () => void;
  onEditModel: (modelId: string) => void;
  onArchiveModel: (modelId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onSetDefault: (modelId: string) => void;
  onValidate: (modelId: string) => void;
  onAuthenticate: () => void;
}) {
  const holdsDefault = defaultModelId !== null;
  // Detected providers are synthesized from the runner's ambient auth and have
  // no providers.json entry, so every catalog write against them resolves to
  // `provider_not_found`. Offer only what can actually succeed: authentication.
  const detected = provider.detected === true;
  const detectedHint = `「${provider.displayName}」由运行端的本地认证自动识别，不在供应商目录中，因此无法编辑或管理其模型`;
  return (
    <section className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{provider.displayName}</h2>
            {provider.archived && <Badge>已归档</Badge>}
            {detected && <Badge>自动识别</Badge>}
          </div>
          <p className="mt-1 font-mono text-[10px] text-text-muted">
            {provider.kind}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-text-muted">
            <KeyRound className="h-3 w-3" />
            {provider.auth.scheme} · {provider.auth.configured ? '已配置凭证' : '未配置凭证'}
          </p>
          {detected && (
            <p className="mt-1.5 text-[10px] text-text-muted">
              凭证来自运行端本地登录，模型列表随之固定；如需自定义模型，请新建一个供应商。
            </p>
          )}
        </div>
        <div className="flex gap-1">
          <Action disabled={disabled} onClick={onAuthenticate}>
            <ShieldCheck className="h-3 w-3" />
            认证
          </Action>
          <Action disabled={disabled || detected} title={detected ? detectedHint : undefined} onClick={onEdit}>
            <Pencil className="h-3 w-3" />
            编辑
          </Action>
          <Action
            disabled={disabled || detected || holdsDefault}
            title={detected ? detectedHint : holdsDefault ? '该供应商持有默认模型，请先切换默认模型' : undefined}
            onClick={onArchive}
          >
            <Archive className="h-3 w-3" />
            归档
          </Action>
          <Action
            disabled={disabled || detected || holdsDefault}
            title={
              detected
                ? detectedHint
                : holdsDefault
                  ? '该供应商持有默认模型，请先切换默认模型'
                  : '永久删除该供应商及其所有模型'
            }
            onClick={() => {
              if (window.confirm(`确定永久删除供应商「${provider.displayName}」及其所有模型？此操作不可恢复。`)) {
                onDelete();
              }
            }}
          >
            <Trash2 className="h-3 w-3" />
            删除
          </Action>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-text-muted">
            <tr>
              <th className="pb-2">模型</th>
              <th className="pb-2">Remote ID</th>
              <th className="pb-2">状态</th>
              <th className="pb-2 text-right">
                <div className="flex justify-end gap-1">
                  <Action
                    disabled={disabled || detected}
                    title={detected ? `${detectedHint}（该认证方式也不提供远程模型列表接口）` : undefined}
                    onClick={onManageModels}
                  >
                    <ListChecks className="h-3 w-3" />
                    管理模型
                  </Action>
                  <Action
                    disabled={disabled || detected}
                    title={detected ? detectedHint : undefined}
                    onClick={onAddModel}
                  >
                    <Plus className="h-3 w-3" />
                    手动添加
                  </Action>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {provider.models.map(model => {
              const isDefault = defaultModelId === model.id;
              return (
                <tr key={model.id} className="border-t border-border/60">
                  <td className="py-2">
                    <span className="font-medium">{model.displayName}</span>
                    {isDefault && (
                      <span className="ml-2">
                        <Badge>默认</Badge>
                      </span>
                    )}
                    {model.archived && (
                      <span className="ml-2">
                        <Badge>已归档</Badge>
                      </span>
                    )}
                  </td>
                  <td className="py-2 font-mono text-[10px] text-text-muted">{model.remoteModelId}</td>
                  <td className="py-2">
                    {model.validation.status === 'valid' ? (
                      <span className="inline-flex items-center gap-1 text-status-active">
                        <CheckCircle2 className="h-3 w-3" />
                        有效
                      </span>
                    ) : model.validation.status === 'invalid' ? (
                      '验证失败'
                    ) : detected ? (
                      <span className="text-text-muted" title="该认证方式没有可用于探测的轻量接口，状态无法验证">
                        不支持验证
                      </span>
                    ) : (
                      '未验证'
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1">
                      <Action
                        disabled={disabled || detected}
                        title={detected ? '该认证方式没有可用于探测的轻量接口，无法验证' : undefined}
                        onClick={() => onValidate(model.id)}
                      >
                        验证
                      </Action>
                      {!isDefault && model.validation.status !== 'invalid' && (
                        <Action
                          disabled={disabled || detected || model.archived}
                          title={detected ? '自动识别的供应商不能设为目录默认；可在对话中单独选用该模型' : undefined}
                          onClick={() => onSetDefault(model.id)}
                        >
                          设为默认
                        </Action>
                      )}
                      <Action
                        disabled={disabled || detected}
                        title={detected ? detectedHint : undefined}
                        onClick={() => onEditModel(model.id)}
                      >
                        编辑
                      </Action>
                      <Action
                        disabled={disabled || detected || isDefault}
                        title={detected ? detectedHint : isDefault ? '默认模型不可归档，请先切换默认模型' : undefined}
                        onClick={() => onArchiveModel(model.id)}
                      >
                        归档
                      </Action>
                      <Action
                        disabled={disabled || detected || isDefault}
                        title={
                          detected ? detectedHint : isDefault ? '默认模型不可删除，请先切换默认模型' : '永久删除该模型'
                        }
                        onClick={() => {
                          if (window.confirm(`确定永久删除模型「${model.displayName}」？此操作不可恢复。`)) {
                            onDeleteModel(model.id);
                          }
                        }}
                      >
                        删除
                      </Action>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {provider.models.length === 0 && (
          <p className="py-4 text-xs text-text-muted">尚未添加模型，可手工输入模型 ID。</p>
        )}
      </div>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[9px] text-brand">{children}</span>;
}
function Action({
  children,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}
