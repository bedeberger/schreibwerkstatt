// Alpine.data('finetuneExportCard') — Sub-Komponente der Finetune-Export-Karte.
//
// State: Typ-Toggles, Längenfenster, Val-Split, Loading/Progress/Status, Stats,
// Job-ID (für Downloads).
// `showFinetuneExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Default-Profil: Unsloth Studio + Mistral-Small-3.2-24B-QLoRA auf 20-GB-GPU
// (z.B. RTX 4000 Ada). Ableitungen:
//   maxChars=4000    → p95 ≈ 1500 Tokens → passt in seq_len=4096
//   maxSeqTokens=4096 → Studio-Empfehlung für 20-GB-QLoRA (bei OOM auf 2048)
//   emitText=false   → Studio rendert das Chat-Template selbst auf Basis des
//                      gewählten Basemodells; ein vorgerenderter text-Feld-
//                      String würde kollidieren. Nur einschalten, wenn du
//                      mit einem CLI-Trainer arbeitest, der `dataset_text_field`
//                      erwartet.

import { finetuneExportMethods } from '../book/finetune-export.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerFinetuneExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('finetuneExportCard', () => ({
    finetuneTypeStyle:      true,
    finetuneTypeScene:      true,
    finetuneTypeVerbatim:   true,
    finetuneTypeDialog:     true,
    finetuneTypeAuthorChat: true,
    finetuneTypeCorrection: true,
    finetuneMinChars:     200,
    finetuneMaxChars:     4000,
    finetuneBiasBoost:    1,
    finetuneMaxTypeShare: 0,   // 0 = kein Typ-Cap; sonst Anteil 0.1–0.95 pro Typ
    finetuneValSplit:     0.1,
    finetuneValSeed:      0,
    finetuneMaxSeqTokens: 4096,   // Sweet-Spot Mistral-Small-3.2-24B-QLoRA @ 20 GB VRAM
    finetuneEmitText:     false,
    finetuneTruncateLong: true,   // Lange Samples kappen statt droppen

    finetuneAiReversePrompts:        false,
    finetuneAiFactQA:                false,
    finetuneAiReasoningBackfill:     false,
    finetuneAiReversePromptsPerPage: 4,
    finetuneAiFactQAPerEntity:       4,

    finetuneLoading:  false,
    finetuneProgress: 0,
    finetuneStatus:   '',
    finetuneJobId:    null,
    finetuneStats:    null,

    _finetunePollTimer: null,
    _lifecycle: null,

    init() {
      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'finetune-export') return;
        const job = d.job;
        this.finetuneLoading = true;
        this.finetuneProgress = job.progress || 0;
        this.finetuneStatus = `<span class="spinner"></span>${
          job.statusText ? window.__app.t(job.statusText, job.statusParams) : window.__app.t('common.analysisRunning')
        }`;
        this.finetuneJobId = d.jobId;
        this.startFinetuneExportPoll(d.jobId);
      };

      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showFinetuneExportCard',
        timerKeys: ['_finetunePollTimer'],
        onShow: () => this._onVisibleFinetuneExport(),
        resetState: {
          finetuneLoading: false,
          finetuneProgress: 0,
          finetuneStatus: '',
          finetuneJobId: null,
          finetuneStats: null,
        },
        extraListeners: [{ type: 'job:reconnect', handler: onJobReconnect }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...finetuneExportMethods,

    ...createCardJobFeature({
      name: 'finetune-export',
      endpoint: '/jobs/finetune-export',
      timerProp: '_finetunePollTimer',
      methodNames: {
        start:     'startFinetuneExportPoll',
        run:       'runFinetuneExport',
        onVisible: '_onVisibleFinetuneExport',
      },
      fields: {
        show:     'showFinetuneExportCard',
        loading:  'finetuneLoading',
        progress: 'finetuneProgress',
        status:   'finetuneStatus',
      },
      i18n: {
        starting:       'finetune.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      buildPayload() {
        this.finetuneStats = null;
        this.finetuneJobId = null;
        return {
          book_id: parseInt(Alpine.store('nav').selectedBookId),
          book_name: window.__app.selectedBookName,
          types: {
            style:      !!this.finetuneTypeStyle,
            scene:      !!this.finetuneTypeScene,
            verbatim:   !!this.finetuneTypeVerbatim,
            dialog:     !!this.finetuneTypeDialog,
            authorChat: !!this.finetuneTypeAuthorChat,
            correction: !!this.finetuneTypeCorrection,
          },
          min_chars:      Number(this.finetuneMinChars) || 200,
          max_chars:      Number(this.finetuneMaxChars) || 4000,
          bias_boost:     Number(this.finetuneBiasBoost) || 1,
          max_type_share: Number(this.finetuneMaxTypeShare) || 0,
          val_split:      Number(this.finetuneValSplit) || 0,
          val_seed:       Number(this.finetuneValSeed)  || 0,
          max_seq_tokens: Number(this.finetuneMaxSeqTokens) || 0,
          emit_text:      !!this.finetuneEmitText,
          truncate_long:  !!this.finetuneTruncateLong,
          ai: {
            reverse_prompts:          !!this.finetuneAiReversePrompts,
            fact_qa:                  !!this.finetuneAiFactQA,
            reasoning_backfill:       !!this.finetuneAiReasoningBackfill,
            reverse_prompts_per_page: Number(this.finetuneAiReversePromptsPerPage) || 4,
            fact_qa_per_entity:       Number(this.finetuneAiFactQAPerEntity)       || 4,
          },
        };
      },
      async onDone(job) {
        this.finetuneJobId = job.id;
        if (job.result?.empty) {
          this.finetuneStatus = window.__app.t('finetune.empty');
          this.finetuneStats = null;
          return;
        }
        this.finetuneStats = job.result?.stats || null;
        this.finetuneStatus = window.__app.t('finetune.done', {
          n: this.finetuneStats?.total ?? 0,
          train: this.finetuneStats?.train ?? 0,
          val: this.finetuneStats?.val ?? 0,
        });
      },
    }),
  }));
}
