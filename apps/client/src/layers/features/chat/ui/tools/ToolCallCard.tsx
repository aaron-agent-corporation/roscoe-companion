import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, X } from 'lucide-react';
import type { ToolCallState, HookState } from '../../model/use-chat-session';
import {
  getToolLabel,
  getMcpServerBadge,
  ToolArgumentsDisplay,
  cn,
  COLLAPSE_TRANSITION,
  COLLAPSE_VARIANTS,
  formatDuration,
} from '@/layers/shared/lib';
import { getToolStatusIcon, CollapsibleCard } from '../primitives';
import { Spinner, TruncatedOutput } from '@/layers/shared/ui';
import { OutputRenderer } from '../message/OutputRenderer';

interface HookRowProps {
  /** Single hook execution to display as a compact sub-row. */
  hook: HookState;
  turnActive?: boolean;
}

/** Status icon map for hook execution states. */
const hookStatusIcon = {
  running: <Spinner size="xs" className="text-muted-foreground" />,
  success: <Check className="text-muted-foreground size-(--size-icon-xs)" />,
  error: <X className="text-destructive size-(--size-icon-xs)" />,
  cancelled: <X className="text-muted-foreground size-(--size-icon-xs)" />,
} satisfies Record<HookState['status'], React.ReactNode>;

/**
 * Compact sub-row for a single hook execution inside a tool call card.
 * Clickable to expand/collapse output. Error hooks start expanded.
 */
function HookRow({ hook, turnActive }: HookRowProps) {
  const hasOutput = !!(hook.stdout || hook.stderr);
  const [expanded, setExpanded] = useState(hook.status === 'error');
  const output = hook.stderr || hook.stdout;

  return (
    <div>
      <button
        onClick={() => hasOutput && setExpanded((e) => !e)}
        className={cn('flex w-full items-center gap-1.5 py-0.5', !hasOutput && 'cursor-default')}
        aria-expanded={hasOutput ? expanded : undefined}
        disabled={!hasOutput}
      >
        {turnActive === false && hook.status === 'running'
          ? getToolStatusIcon('neutral')
          : hookStatusIcon[hook.status]}
        <span
          className={cn(
            'text-3xs font-mono',
            hook.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {hook.hookName}
        </span>
        {hook.status === 'error' && <span className="text-3xs text-destructive">failed</span>}
        {hook.exitCode !== undefined && (
          <span className="text-3xs text-muted-foreground ml-auto">exit {hook.exitCode}</span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasOutput && output && (
          <motion.div
            variants={COLLAPSE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={COLLAPSE_TRANSITION}
            className="overflow-hidden"
          >
            <pre className="text-muted-foreground max-h-32 overflow-y-auto py-1 text-xs whitespace-pre-wrap">
              {output}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface ToolCallCardProps {
  toolCall: ToolCallState;
  defaultExpanded?: boolean;
  /** False for a settled turn, even if its transcript has no final tool result. */
  turnActive?: boolean;
}

/** Expandable card displaying a tool call's status, arguments, and result. */
export function ToolCallCard({ toolCall, defaultExpanded = false, turnActive }: ToolCallCardProps) {
  const inactive =
    turnActive === false && (toolCall.status === 'running' || toolCall.status === 'pending');
  const displayStatus = inactive ? 'neutral' : toolCall.status;
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasProgress = !!toolCall.progressOutput;

  useEffect(() => {
    if (hasProgress && !expanded) {
      setExpanded(true); // eslint-disable-line react-hooks/set-state-in-effect -- Intentional: auto-expand once when progress first arrives
    }
  }, [hasProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  const hooksSection =
    toolCall.hooks && toolCall.hooks.length > 0 ? (
      <div className="border-border/50 space-y-0.5 border-t px-3 py-1">
        {toolCall.hooks.map((hook) => (
          <HookRow key={hook.hookId} hook={hook} turnActive={turnActive} />
        ))}
      </div>
    ) : undefined;

  const duration =
    toolCall.startedAt && toolCall.completedAt
      ? toolCall.completedAt - toolCall.startedAt
      : undefined;

  const badge = getMcpServerBadge(toolCall.toolName);

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dimmed={toolCall.status === 'complete'}
      extraContent={hooksSection}
      data-testid="tool-call-card"
      data-tool-name={toolCall.toolName}
      data-status={displayStatus}
      header={
        <>
          {getToolStatusIcon(displayStatus)}
          {badge && (
            <span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium">
              {badge}
            </span>
          )}
          <span className="text-3xs flex-1 text-left font-mono">
            {getToolLabel(toolCall.toolName, toolCall.input)}
          </span>
          {inactive && <span className="text-muted-foreground text-3xs">Not running</span>}
          {duration !== undefined && (
            <span className="text-muted-foreground text-3xs tabular-nums">
              {formatDuration(duration)}
            </span>
          )}
        </>
      }
    >
      {inactive && toolCall.result === undefined && (
        <p className="text-muted-foreground py-1 text-xs">
          This turn has ended. No result was recorded for this tool.
        </p>
      )}
      {displayStatus === 'running' && !toolCall.input ? (
        <div className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs">
          <Spinner size="xs" />
          <span>Preparing…</span>
        </div>
      ) : toolCall.input !== undefined && toolCall.input !== '' ? (
        <ToolArgumentsDisplay
          toolName={toolCall.toolName}
          input={toolCall.input}
          isStreaming={displayStatus === 'running'}
        />
      ) : null}
      {toolCall.progressOutput && !toolCall.result && (
        <TruncatedOutput content={toolCall.progressOutput} className="mt-2 border-t pt-2" />
      )}
      {toolCall.result && (
        <div className="mt-2 border-t pt-2">
          <OutputRenderer
            content={toolCall.result}
            toolName={toolCall.toolName}
            input={toolCall.input}
          />
        </div>
      )}
    </CollapsibleCard>
  );
}
