"use client";
import React, { useState } from 'react';

interface RegenButtonProps {
  storyId: string;
  pageIndex: number;
  originalPrompt: string;
  onUpdate: (imageUrl: string) => void;
}

export const RegenButton: React.FC<RegenButtonProps> = ({ storyId, pageIndex, originalPrompt, onUpdate }) => {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/regen-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyId, pageIndex, originalPrompt, feedback }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Generation failed');
      }
      setPreviewUrl(data.imageUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (previewUrl) {
      onUpdate(previewUrl);
      setOpen(false);
      setPreviewUrl(null);
      setFeedback('');
    }
  }

  return (
    <>
      <button
        type="button"
        className="rounded bg-indigo-600 px-4 py-2 text-white text-sm hover:bg-indigo-700"
        onClick={() => setOpen(true)}
      >
        Regenerate Image
      </button>
      {open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">Regenerate Page Image</h3>
            <textarea
              placeholder="Describe changes here"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-md px-3 py-2 mb-4 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
            <div className="flex items-center justify-end space-x-2">
              <button
                type="button"
                className="px-4 py-2 text-sm rounded bg-gray-200"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              {!previewUrl ? (
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded bg-indigo-600 text-white disabled:opacity-50"
                  onClick={generate}
                  disabled={busy}
                >
                  {busy ? 'Generating...' : 'Generate'}
                </button>
              ) : (
                <>
                  <img src={previewUrl} alt="Preview" className="mb-4 w-full rounded" />
                  <button
                    type="button"
                    className="px-4 py-2 text-sm rounded bg-green-600 text-white"
                    onClick={save}
                  >
                    Save Image
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
