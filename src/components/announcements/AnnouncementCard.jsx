// One announcement, rendered as a card. The board, the carousel and the live
// preview inside the administration editor all use this single component, so
// what the administrator sees while typing is what employees get.

import { Check, Pin } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { formatDate, pickLocalized } from '../../utils/localize';
import './announcements.css';

const EXCERPT_LENGTH = 190;

const excerptOf = (text) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > EXCERPT_LENGTH ? `${clean.slice(0, EXCERPT_LENGTH).trimEnd()}…` : clean;
};

const AnnouncementCard = ({
  announcement,
  isRead = false,
  onOpen,
  onMarkRead,
  showActions = true,
}) => {
  const { t, lang, locale } = useLanguage();

  const title = pickLocalized(announcement, 'title', lang, t('ann_untitled'));
  const body = pickLocalized(announcement, 'body', lang, '');
  const priority = announcement.priority || 'Normal';
  const publishedOn = announcement.publish_from || announcement.created_on;

  return (
    <article
      className={`announcement-card${announcement.is_pinned ? ' is-pinned' : ''}`}
      data-priority={priority}
      aria-label={title}
    >
      <div className="announcement-card-top">
        {announcement.is_pinned && (
          <span className="announcement-flag pin">
            <Pin size={13} aria-hidden="true" />
            {t('ann_pinned')}
          </span>
        )}
        {priority !== 'Normal' && (
          <span className={`announcement-flag priority-${priority}`}>
            {t(`ann_priority_${priority.toLowerCase()}`)}
          </span>
        )}
        {isRead && (
          <span className="announcement-flag read">
            <Check size={13} aria-hidden="true" />
            {t('ann_is_read')}
          </span>
        )}
        {publishedOn && (
          <span className="announcement-card-date">
            {t('ann_published_on', { date: formatDate(publishedOn, locale) })}
          </span>
        )}
      </div>

      {announcement.image_url && (
        <div className="announcement-media">
          <img src={announcement.image_url} alt={t('ann_image_alt', { title })} loading="lazy" />
        </div>
      )}

      <h3>{title}</h3>
      {body && <p className="announcement-excerpt">{excerptOf(body)}</p>}

      {showActions && (
        <div className="announcement-card-actions">
          {onOpen && (
            <button type="button" className="text-button" onClick={() => onOpen(announcement)}>
              {t('ann_read_more')}
            </button>
          )}
          {onMarkRead && !isRead && (
            <button
              type="button"
              className="secondary-button announcement-read-action"
              onClick={() => onMarkRead(announcement)}
            >
              <Check size={15} aria-hidden="true" />
              {t('ann_mark_read')}
            </button>
          )}
        </div>
      )}
    </article>
  );
};

export default AnnouncementCard;
