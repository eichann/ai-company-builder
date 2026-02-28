import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Lightning,
  FileText,
  ArrowRight,
  ArrowLeft,
  Sparkle,
  Check
} from '@phosphor-icons/react'

interface NewSkillWizardProps {
  departmentName: string
  color: string
  onClose: () => void
  onComplete: (skillData: { name: string; description: string; prompt: string; folderName: string }) => void
}

type Step = 'name' | 'description' | 'prompt' | 'confirm'

// Generate folder name from display name (alphanumeric, -, _ only)
function generateFolderName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with -
    .replace(/^-|-$/g, '')        // Remove leading/trailing -
    .substring(0, 50)             // Limit length
    || 'new-skill'                // Fallback
}

// Validate folder name (alphanumeric, -, _ only)
function isValidFolderName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

export function NewSkillWizard({
  departmentName,
  color,
  onClose,
  onComplete,
}: NewSkillWizardProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('name')
  const [name, setName] = useState('')
  const [folderName, setFolderName] = useState('')
  const [folderNameEdited, setFolderNameEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')

  // Auto-generate folder name when name changes (unless manually edited)
  const handleNameChange = (newName: string) => {
    setName(newName)
    if (!folderNameEdited) {
      setFolderName(generateFolderName(newName))
    }
  }

  const handleFolderNameChange = (newFolderName: string) => {
    // Only allow valid characters
    const sanitized = newFolderName.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    setFolderName(sanitized)
    setFolderNameEdited(true)
  }

  const folderNameValid = isValidFolderName(folderName)

  const steps: { id: Step; label: string; number: number }[] = [
    { id: 'name', label: t('skillWizard.nameLabel'), number: 1 },
    { id: 'description', label: t('skillWizard.descriptionLabel'), number: 2 },
    { id: 'prompt', label: t('skillWizard.promptLabel', 'AIへの指示'), number: 3 },
    { id: 'confirm', label: t('common.confirm'), number: 4 },
  ]

  const currentStepIndex = steps.findIndex((s) => s.id === step)

  const handleNext = () => {
    if (step === 'name' && name.trim() && folderNameValid) {
      setStep('description')
    } else if (step === 'description') {
      setStep('prompt')
    } else if (step === 'prompt') {
      setStep('confirm')
    } else if (step === 'confirm') {
      onComplete({ name: name.trim(), description: description.trim(), prompt: prompt.trim(), folderName })
    }
  }

  const handleBack = () => {
    if (step === 'description') {
      setStep('name')
    } else if (step === 'prompt') {
      setStep('description')
    } else if (step === 'confirm') {
      setStep('prompt')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-lg bg-zinc-900 rounded-2xl border border-zinc-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${color}20` }}
            >
              <Lightning size={16} weight="fill" style={{ color }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">{t('skillWizard.title')}</h2>
              <p className="text-xs text-zinc-500">{t('skillWizard.subtitle', { department: departmentName })}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.05] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-2 px-6 py-4 border-b border-zinc-800/50">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={`
                  w-7 h-7 rounded-full flex items-center justify-center
                  text-xs font-medium transition-colors
                  ${i <= currentStepIndex
                    ? 'text-white'
                    : 'bg-zinc-800 text-zinc-600'
                  }
                `}
                style={{
                  backgroundColor: i <= currentStepIndex ? color : undefined,
                }}
              >
                {i < currentStepIndex ? <Check size={14} weight="bold" /> : s.number}
              </div>
              <span
                className={`text-xs ${
                  i <= currentStepIndex ? 'text-zinc-300' : 'text-zinc-600'
                }`}
              >
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <div
                  className={`w-8 h-px mx-2 ${
                    i < currentStepIndex ? '' : 'bg-zinc-800'
                  }`}
                  style={{
                    backgroundColor: i < currentStepIndex ? color : undefined,
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 min-h-[200px]">
          {step === 'name' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  {t('skillWizard.nameLabel')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder={t('skillWizard.namePlaceholder')}
                  className="
                    w-full px-4 py-3 rounded-xl
                    bg-zinc-800 border border-zinc-700
                    text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:border-transparent
                    transition-all
                  "
                  style={{ focusRing: color } as React.CSSProperties}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">
                  {t('skillWizard.folderNameLabel', 'フォルダ名')}
                </label>
                <p className="text-xs text-zinc-500 mb-2">
                  {t('skillWizard.folderNameHint', '英数字、ハイフン(-)、アンダースコア(_)のみ使用可能')}
                </p>
                <input
                  type="text"
                  value={folderName}
                  onChange={(e) => handleFolderNameChange(e.target.value)}
                  placeholder="my-skill-name"
                  className={`
                    w-full px-4 py-3 rounded-xl
                    bg-zinc-800 border
                    text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:border-transparent
                    transition-all font-mono text-sm
                    ${folderName && !folderNameValid ? 'border-red-500' : 'border-zinc-700'}
                  `}
                />
                {folderName && !folderNameValid && (
                  <p className="text-xs text-red-400 mt-1">
                    {t('skillWizard.folderNameError', '英小文字で始まり、英数字・ハイフン・アンダースコアのみ使用してください')}
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 'description' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  {t('skillWizard.descriptionLabel')}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('skillWizard.descriptionPlaceholder')}
                  rows={4}
                  className="
                    w-full px-4 py-3 rounded-xl
                    bg-zinc-800 border border-zinc-700
                    text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:border-transparent
                    transition-all resize-none
                  "
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 'prompt' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  {t('skillWizard.promptLabel', 'AIへの指示')}
                </label>
                <p className="text-xs text-zinc-500 mb-3">
                  {t('skillWizard.promptHint', 'このスキルを実行するとき、AIがどのように振る舞うべきか詳しく書いてください。')}
                </p>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('skillWizard.promptPlaceholder', '例: ユーザーの要望を聞いて、提案書を作成してください。提案書には以下の要素を含めてください...')}
                  rows={8}
                  className="
                    w-full px-4 py-3 rounded-xl
                    bg-zinc-800 border border-zinc-700
                    text-zinc-100 placeholder:text-zinc-600
                    focus:outline-none focus:ring-2 focus:border-transparent
                    transition-all resize-none
                    font-mono text-sm
                  "
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 'confirm' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-white/[0.03] border border-zinc-800">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: `${color}20` }}
                  >
                    <FileText size={20} weight="fill" style={{ color }} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">{name}</h3>
                    <p className="text-xs text-zinc-500">{departmentName} / <span className="font-mono">{folderName}/</span></p>
                  </div>
                </div>
                <p className="text-sm text-zinc-400 mb-3">
                  {description || t('skillWizard.noDescription', '説明なし')}
                </p>
                {prompt && (
                  <div className="pt-3 border-t border-zinc-800">
                    <p className="text-xs text-zinc-500 mb-1">{t('skillWizard.promptLabel', 'AIへの指示')}</p>
                    <p className="text-xs text-zinc-400 line-clamp-3 font-mono">
                      {prompt}
                    </p>
                  </div>
                )}
              </div>

              <div className="text-xs text-zinc-500 px-1">
                {t('skillWizard.foldersCreated', '作成されるフォルダ:')} <span className="font-mono">rules/</span>, <span className="font-mono">references/</span>, <span className="font-mono">scripts/</span>, <span className="font-mono">tools/</span>
              </div>

              <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <Sparkle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200">
                  {t('skillWizard.editHint')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
          <button
            onClick={handleBack}
            disabled={step === 'name'}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg
              text-sm font-medium
              transition-colors
              ${step === 'name'
                ? 'text-zinc-700 cursor-not-allowed'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05]'
              }
            `}
          >
            <ArrowLeft size={14} />
            {t('common.back')}
          </button>

          <button
            onClick={handleNext}
            disabled={step === 'name' && (!name.trim() || !folderNameValid)}
            className={`
              flex items-center gap-2 px-5 py-2.5 rounded-lg
              text-sm font-medium text-white
              transition-all cursor-pointer
              disabled:opacity-50 disabled:cursor-not-allowed
              hover:brightness-110 active:scale-[0.98]
            `}
            style={{ backgroundColor: color }}
          >
            {step === 'confirm' ? (
              <>
                <Check size={14} weight="bold" />
                {t('skillWizard.createButton')}
              </>
            ) : (
              <>
                {t('common.next')}
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
