import type { useOrderSubmission } from '../hooks/useOrderSubmission';

export function SubmissionFeedback({ submission, onStartAnother }: {
  submission: ReturnType<typeof useOrderSubmission>;
  onStartAnother: () => void;
}) {
  if (!submission.message) return null;
  return <div role="status" className="my-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200 break-words">
    <p>{submission.message}</p>
    {submission.uid && <p className="mt-1 text-[10px] font-mono break-all">Order: {submission.uid}</p>}
    {submission.canStartAnother && <button type="button" className="mt-2 underline font-semibold" onClick={() => {
      onStartAnother(); submission.clear();
    }}>Start another order</button>}
  </div>;
}
