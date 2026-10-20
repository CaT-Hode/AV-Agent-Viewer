import { GlassSwitch, GlassRangeControl } from './GlassControls';
import { GlassSegmentedControl } from './GlassSegmentedControl';
import { DocumentPaperColorControl } from './DocumentPaperColorControl';
import { ShortcutInput } from './ShortcutInput';
import { DEFAULT_SELECTION_SHORTCUT } from '../../../../../packages/contracts/src/selection-shortcut';
import type { SettingDefinition, SettingsSnapshot, SettingValue } from '../../../../../packages/settings/src/index';

function groupFor(definition: SettingDefinition) {
  const id = definition.id.toLowerCase();
  if (id.includes('selection')) return '选区与即时操作';
  if (id.includes('web') || id.includes('site')) return '网页与站点';
  if (/theme|density|glass|motion|background|contrast/.test(id)) return '视觉与材质';
  if (/width|toolbar|layout|rail/.test(id)) return '工具与布局';
  if (/translate|translation/.test(id)) return '文档翻译';
  if (/save|backup|recover|restore|retention/.test(id)) return '保存与恢复';
  if (/model|driver|budget|concurr|retry/.test(id)) return '执行方式';
  return '常用偏好';
}
export function SettingsGroups({ definitions, snapshot, labels, onChange }: {
  definitions: SettingDefinition[]; snapshot?: SettingsSnapshot; labels: Record<string, string>; onChange(id: string, value: SettingValue): void;
}) {
  const available = definitions.filter(definition => definition.available), unavailable = definitions.filter(definition => !definition.available);
  const groups = [...new Set(available.map(groupFor))];
  const render = (definition: SettingDefinition) => {
    const value = snapshot?.values[definition.id] ?? definition.defaultValue, enabled = !!definition.available;
    return <div className={'setting-row setting-' + definition.type + (!enabled ? ' unavailable' : '')} data-setting-id={definition.id} key={definition.id}>
      <div className="setting-copy"><div className="setting-label">{definition.label}{value !== definition.defaultValue && <span className="modified-dot" title="已修改" />}</div>
        {definition.description && <p>{definition.description}</p>}{!enabled && <p className="dependency-note">{definition.unavailableReason}</p>}
        {definition.id === 'translation.selectionShortcutEnabled' && value === true && <p className="setting-shortcut-hint" role="status">已开启：选中文字后按 <kbd>{String(snapshot?.values['translation.selectionShortcut'] ?? DEFAULT_SELECTION_SHORTCUT)}</kbd>；译文向下拖动可收起。</p>}
        <details className="setting-metadata"><summary>详细信息</summary><small>{definition.id} · {definition.effect === 'next-task' ? '下次任务生效' : definition.effect === 'reopen' ? '重新打开后生效' : definition.effect === 'restart' ? '重启后生效' : '立即生效'} · 应用设置</small></details>
      </div>
      <div className="setting-control" inert={!enabled}>
        {definition.id === 'translation.selectionShortcut' ? <ShortcutInput label={definition.label} value={String(value)} disabled={!enabled} onChange={next => onChange(definition.id, next)} /> : definition.id === 'appearance.documentPaperColor' ? <DocumentPaperColorControl label={definition.label} value={String(value)} onChange={next => onChange(definition.id,next)} /> : definition.type === 'boolean' ? <GlassSwitch label={definition.label} checked={!!value} disabled={!enabled} onChange={next => onChange(definition.id, next)} /> : definition.type === 'select' ?
          <GlassSegmentedControl label={definition.label} value={String(value)} disabled={!enabled} options={(definition.options ?? []).map(option => ({ value: option, label: labels[option] ?? option }))} onChange={next => onChange(definition.id, next)} /> : definition.type === 'number' && definition.id === 'appearance.toolbarDelayMs' ?
            <GlassRangeControl label={definition.label} value={Number(value)} disabled={!enabled} min={definition.min!} max={definition.max!} step={definition.id.endsWith('Ms') ? 100 : 1} onChange={next => onChange(definition.id, next)} /> : definition.type === 'number' ?
              <input aria-label={definition.label} disabled={!enabled} type="number" min={definition.min} max={definition.max} step={definition.id==='translation.capsuleGrowthRatio'?.05:1} value={Number(value)} onChange={event => { if (event.target.value !== '') onChange(definition.id, Number(event.target.value)); }} /> :
              <input aria-label={definition.label} disabled={!enabled} value={String(value)} onChange={event => onChange(definition.id, event.target.value)} />}
      </div>
    </div>;
  };
  return <div className="settings-groups">{groups.map(group => <section className="settings-group" key={group}><h2>{group}</h2><div className="settings-group-card">{available.filter(definition => groupFor(definition) === group).map(render)}</div></section>)}
    {!!unavailable.length && <details className="settings-unavailable"><summary>尚未接入的选项<span>{unavailable.length}</span></summary><p>这些选项需要对应引擎能力，当前仅展示说明。</p><div className="settings-group-card">{unavailable.map(render)}</div></details>}
  </div>;
}
