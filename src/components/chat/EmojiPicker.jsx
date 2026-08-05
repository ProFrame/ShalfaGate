import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';

// A categorised picker built from a static list — no extra dependency, no
// network call, and the category names come from the dictionary like every
// other label in the product.
const EMOJI_CATEGORIES = [
  {
    code: 'smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂',
      '🙃', '😉', '😊', '😇', '🥰', '😍', '😘', '😗',
      '😚', '😋', '😛', '😜', '🤪', '🤗', '🤔', '🤨',
      '😐', '😑', '😶', '🙄', '😏', '😴', '😪', '😵',
      '🥳', '😎', '🤓', '🧐', '😕', '😟', '😢', '😭',
      '😤', '😠', '😡', '🤯', '😳', '🥺', '😬', '🤐',
    ],
  },
  {
    code: 'gestures',
    icon: '👍',
    emojis: [
      '👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌',
      '🙏', '💪', '👋', '🤙', '☝️', '✋', '🖐️', '🤲',
      '👊', '✊', '🫡', '🫶', '👇', '👆', '👉', '👈',
    ],
  },
  {
    code: 'people',
    icon: '🧑',
    emojis: [
      '🧑', '👨', '👩', '🧑‍💼', '👨‍💼', '👩‍💼', '🧑‍💻', '👨‍💻',
      '👩‍💻', '🧑‍🏭', '👷', '🧑‍🔧', '🧑‍⚕️', '🧑‍🏫', '🧑‍🍳', '👮',
      '🧑‍🚀', '🤵', '👥', '🗣️', '👤', '🧑‍🤝‍🧑', '💁', '🙋',
    ],
  },
  {
    code: 'nature',
    icon: '🌿',
    emojis: [
      '🌿', '🌱', '🌳', '🌴', '🌵', '🍀', '🌸', '🌼',
      '🌻', '🌷', '🌹', '☀️', '🌤️', '⛅', '🌧️', '⛈️',
      '❄️', '🔥', '💧', '🌙', '⭐', '🌟', '⚡', '🌈',
    ],
  },
  {
    code: 'food',
    icon: '☕',
    emojis: [
      '☕', '🍵', '🥤', '🧃', '🍽️', '🍞', '🥐', '🥗',
      '🍕', '🍔', '🌮', '🍜', '🍚', '🍗', '🍰', '🍫',
      '🍎', '🍌', '🍇', '🍓', '🍉', '🥑', '🧁', '🍪',
    ],
  },
  {
    code: 'activity',
    icon: '📈',
    emojis: [
      '📈', '📉', '📊', '🎯', '🏆', '🥇', '🎉', '🎊',
      '🎁', '⚽', '🏀', '🏐', '🎾', '🏃', '🚴', '🧗',
      '🎵', '🎧', '🎬', '📅', '⏰', '⌛', '🔔', '📌',
    ],
  },
  {
    code: 'travel',
    icon: '✈️',
    emojis: [
      '✈️', '🚗', '🚕', '🚌', '🚐', '🚚', '🚀', '🛰️',
      '🚉', '🛣️', '🏢', '🏭', '🏗️', '🏠', '🏙️', '🕌',
      '🗺️', '🧭', '📍', '🛫', '🛬', '⛽', '🚦', '🅿️',
    ],
  },
  {
    code: 'objects',
    icon: '📎',
    emojis: [
      '📎', '📄', '📁', '🗂️', '📋', '🖊️', '✏️', '📐',
      '💼', '🔑', '🔒', '🔓', '💻', '🖥️', '📱', '☎️',
      '🖨️', '💡', '🔋', '🔍', '📷', '🎥', '📚', '🧾',
    ],
  },
  {
    code: 'symbols',
    icon: '✅',
    emojis: [
      '✅', '❌', '⚠️', 'ℹ️', '❓', '❗', '➕', '➖',
      '💯', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫',
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '💔',
    ],
  },
];

/**
 * @param {object}   props
 * @param {Function} props.onSelect  receives the chosen emoji character
 * @param {Function} props.onClose   called on Escape or an outside click
 */
const EmojiPicker = ({ onSelect, onClose }) => {
  const { t } = useLanguage();
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0].code);
  const panelRef = useRef(null);

  useEffect(() => {
    const handlePointer = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) onClose?.();
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  const active = EMOJI_CATEGORIES.find((item) => item.code === category) || EMOJI_CATEGORIES[0];

  return (
    <div className="chat-emoji-panel" role="dialog" aria-label={t('chat_emoji_picker')} ref={panelRef}>
      <div className="chat-emoji-tabs" role="tablist" aria-label={t('chat_emoji')}>
        {EMOJI_CATEGORIES.map((item) => (
          <button
            key={item.code}
            type="button"
            role="tab"
            aria-selected={item.code === active.code}
            className={item.code === active.code ? 'active' : ''}
            title={t(`chat_emoji_${item.code}`)}
            aria-label={t(`chat_emoji_${item.code}`)}
            onClick={() => setCategory(item.code)}
          >
            <span aria-hidden="true">{item.icon}</span>
          </button>
        ))}
      </div>
      <div className="chat-emoji-grid" role="tabpanel" aria-label={t(`chat_emoji_${active.code}`)}>
        {active.emojis.map((emoji) => (
          <button key={emoji} type="button" aria-label={emoji} onClick={() => onSelect?.(emoji)}>
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default EmojiPicker;
