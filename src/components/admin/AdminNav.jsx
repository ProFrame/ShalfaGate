/* eslint-disable react-refresh/only-export-components */
// The administration sidebar.
//
// The list of admin screens grew past the point where a flat column is usable,
// so it is grouped: Organisation, Performance management, Content, Approvals,
// Verification and Settings. Every entry is filtered three times before it is
// drawn — by public.my_screens() when the database can answer, by the company's
// module licence, and by the role — and a group that ends up empty disappears
// entirely rather than showing a heading with nothing under it.
//
// The open group and the active screen live in the address (/app/admin/:section)
// so any screen can be linked to, bookmarked and shared.

import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlarmClock, Award, BarChart3, BellRing, BookOpenCheck, Boxes, BriefcaseBusiness, Building2,
  CalendarDays, ChevronDown, ChevronLeft, ChevronRight, CircleGauge, ClipboardCheck, ClipboardList,
  Copy, ExternalLink, FileBadge, FileStack, Gauge, GitBranch, Globe, Goal, HardHat, History, Layers,
  LayoutGrid, LifeBuoy, MapPin, MapPinCheck, Megaphone, Package, PackageCheck, Palette, ScrollText,
  Shield, ShieldCheck, ShieldHalf, Stamp, UserCog, UserRoundCog, Users, Warehouse, Wrench,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useTenant } from '../../context/TenantContext';
import { loadMyScreens } from '../../data/notificationCenterService';

/**
 * The navigation model.
 *
 * id       the URL section (/app/admin/:section) and the content key
 * code     the public.app_screens code used to filter against my_screens()
 * module   the licensed module the screen belongs to, when it has one
 * basic    visible to a system administrator, not only to the company owner
 * href     an app path when the screen lives outside the admin shell
 * needs    a component key that must be resolvable before the entry is shown
 */
export const ADMIN_GROUPS = [
  {
    id: 'organization',
    labelKey: 'admin_group_organization',
    icon: Building2,
    items: [
      { id: 'employees', code: 'ADMIN_EMPLOYEES', labelKey: 'admin_nav_employees', icon: Users, module: 'EMPLOYEE_PORTAL', basic: true },
      { id: 'departments', code: 'ADMIN_DEPARTMENTS', labelKey: 'admin_nav_departments', icon: Building2, module: 'EMPLOYEE_PORTAL' },
      { id: 'positions', code: 'ADMIN_POSITIONS', labelKey: 'admin_nav_positions', icon: BriefcaseBusiness, module: 'EMPLOYEE_PORTAL' },
      { id: 'sectors', code: 'ADMIN_SECTORS', labelKey: 'admin_nav_sectors', icon: Layers, module: 'EMPLOYEE_PORTAL' },
      { id: 'projects', code: 'ADMIN_PROJECTS', labelKey: 'admin_nav_projects', icon: LayoutGrid, module: 'EMPLOYEE_PORTAL' },
      { id: 'sites', code: 'ADMIN_SITES', labelKey: 'admin_nav_sites', icon: MapPin, module: 'EMPLOYEE_PORTAL' },
      { id: 'countries', code: 'ADMIN_COUNTRIES', labelKey: 'admin_nav_countries', icon: Globe, module: 'EMPLOYEE_PORTAL' },
    ],
  },
  {
    id: 'performance',
    labelKey: 'admin_group_performance',
    icon: BarChart3,
    items: [
      { id: 'cycles', code: 'ADMIN_PERFORMANCE_CYCLES', labelKey: 'admin_nav_cycles', icon: Activity, module: 'PERFORMANCE' },
      { id: 'goals', code: 'ADMIN_GOALS', labelKey: 'admin_nav_goals', icon: Goal, module: 'PERFORMANCE' },
      { id: 'competencies', code: 'ADMIN_COMPETENCIES', labelKey: 'admin_nav_competencies', icon: BookOpenCheck, module: 'PERFORMANCE' },
      { id: 'proficiency', code: 'ADMIN_PROFICIENCY', labelKey: 'admin_nav_proficiency', icon: CircleGauge, module: 'PERFORMANCE' },
      { id: 'performance', code: 'ADMIN_PERFORMANCE_DASHBOARD', labelKey: 'admin_nav_performance', icon: BarChart3, module: 'PERFORMANCE', basic: true },
    ],
  },
  {
    id: 'content',
    labelKey: 'admin_group_content',
    icon: FileStack,
    items: [
      { id: 'documents', code: 'ADMIN_CONTENT', labelKey: 'admin_nav_documents', icon: FileStack, module: 'DOCUMENTS', basic: true },
      { id: 'circulars', code: 'ADMIN_CONTENT', labelKey: 'admin_nav_circulars', icon: ScrollText, module: 'DOCUMENTS', basic: true },
      { id: 'designs', code: 'ADMIN_CONTENT', labelKey: 'admin_nav_designs', icon: Palette, module: 'DOCUMENTS', basic: true },
      { id: 'announcements', code: 'ADMIN_ANNOUNCEMENTS', labelKey: 'admin_nav_announcements', icon: Megaphone, module: 'ANNOUNCEMENTS', basic: true },
      { id: 'surveys', code: 'ADMIN_SURVEYS', labelKey: 'admin_nav_surveys', icon: ClipboardList, module: 'SURVEY', basic: true },
      { id: 'calendar', code: 'ADMIN_CALENDAR', labelKey: 'admin_nav_calendar', icon: CalendarDays, module: 'CALENDAR', basic: true },
    ],
  },
  {
    id: 'assets',
    labelKey: 'admin_group_assets',
    icon: Boxes,
    items: [
      { id: 'asset-groups', code: 'ADMIN_ASSET_GROUPS', labelKey: 'admin_nav_asset_groups', icon: Layers, module: 'ASSETS' },
      { id: 'asset-custody-units', code: 'ADMIN_ASSET_CUSTODY_UNITS', labelKey: 'admin_nav_asset_custody_units', icon: Warehouse, module: 'ASSETS' },
      { id: 'assets', code: 'ADMIN_ASSETS_CATALOGUE', labelKey: 'admin_nav_assets_catalogue', icon: Boxes, module: 'ASSETS', basic: true },
      { id: 'asset-inventory', code: 'ADMIN_ASSET_INVENTORY', labelKey: 'admin_nav_asset_inventory', icon: ClipboardCheck, module: 'ASSETS' },
      { id: 'asset-reports', code: 'ADMIN_ASSET_REPORTS', labelKey: 'admin_nav_asset_reports', icon: BarChart3, module: 'ASSETS', basic: true },
    ],
  },
  {
    id: 'safety',
    labelKey: 'admin_group_safety',
    icon: Shield,
    items: [
      { id: 'safety-ppe-types', code: 'ADMIN_SAFETY_PPE_TYPES', labelKey: 'admin_nav_safety_ppe_types', icon: HardHat, module: 'SAFETY' },
      { id: 'safety-ppe-sets', code: 'ADMIN_SAFETY_PPE_SETS', labelKey: 'admin_nav_safety_ppe_sets', icon: Package, module: 'SAFETY' },
      { id: 'safety-assets', code: 'ADMIN_SAFETY_ASSETS', labelKey: 'admin_nav_safety_assets', icon: PackageCheck, module: 'SAFETY' },
      { id: 'safety-issuances', code: 'ADMIN_SAFETY_ISSUANCES', labelKey: 'admin_nav_safety_issuances', icon: ClipboardList, module: 'SAFETY', basic: true },
      { id: 'safety-field-visits', code: 'ADMIN_SAFETY_FIELD_VISITS', labelKey: 'admin_nav_safety_field_visits', icon: MapPinCheck, module: 'SAFETY', basic: true },
      { id: 'safety-expirations', code: 'ADMIN_SAFETY_EXPIRATIONS', labelKey: 'admin_nav_safety_expirations', icon: AlarmClock, module: 'SAFETY' },
      { id: 'safety-compliance', code: 'ADMIN_SAFETY_COMPLIANCE', labelKey: 'admin_nav_safety_compliance', icon: Gauge, module: 'SAFETY', basic: true },
      { id: 'safety-reports', code: 'ADMIN_SAFETY_REPORTS', labelKey: 'admin_nav_safety_reports', icon: BarChart3, module: 'SAFETY', basic: true },
    ],
  },
  {
    id: 'operations',
    labelKey: 'admin_group_operations',
    icon: Wrench,
    items: [
      { id: 'operations', code: 'ADMIN_OPERATIONS_LIST', labelKey: 'admin_nav_operations_list', icon: ClipboardList, module: 'OPERATIONS', basic: true },
      { id: 'operations-dashboard', code: 'ADMIN_OPERATIONS_DASHBOARD', labelKey: 'admin_nav_operations_dashboard', icon: Gauge, module: 'OPERATIONS', basic: true },
      { id: 'operations-templates', code: 'ADMIN_OPERATIONS_TEMPLATES', labelKey: 'admin_nav_operations_templates', icon: Copy, module: 'OPERATIONS' },
    ],
  },
  {
    id: 'approvals',
    labelKey: 'admin_group_approvals',
    icon: GitBranch,
    items: [
      { id: 'approval-roles', code: 'ADMIN_APPROVAL_ROLES', labelKey: 'admin_nav_approval_roles', icon: UserRoundCog, module: 'APPROVALS' },
      { id: 'approval-schemes', code: 'ADMIN_APPROVAL_SCHEMES', labelKey: 'admin_nav_approval_schemes', icon: GitBranch, module: 'APPROVALS' },
      { id: 'approval-tracking', code: 'ADMIN_APPROVAL_TRACKING', labelKey: 'admin_nav_approval_tracking', icon: Activity, module: 'APPROVALS', basic: true },
      { id: 'approval-all-requests', code: 'ADMIN_APPROVAL_ALL_REQUESTS', labelKey: 'admin_nav_approval_all_requests', icon: ClipboardList, module: 'APPROVALS', basic: true },
    ],
  },
  {
    id: 'verification',
    labelKey: 'admin_group_verification',
    icon: ShieldCheck,
    items: [
      { id: 'attestations', code: 'ADMIN_ATTESTATIONS', labelKey: 'admin_nav_attestations', icon: FileBadge, module: 'VERIFICATION', href: '/app/verification/attestations', needs: 'verification' },
      { id: 'certificates', code: 'ADMIN_CERTIFICATES', labelKey: 'admin_nav_certificates', icon: Award, module: 'CERTIFICATES', href: '/app/verification/certificates', needs: 'verification' },
      { id: 'certificate-templates', code: 'ADMIN_CERTIFICATE_TEMPLATES', labelKey: 'admin_nav_certificate_templates', icon: Stamp, module: 'CERTIFICATES', href: '/app/verification/templates', needs: 'verification' },
      { id: 'verification-settings', code: 'ADMIN_VERIFICATION_SETTINGS', labelKey: 'admin_nav_verification_settings', icon: ShieldCheck, module: 'VERIFICATION', href: '/app/verification/settings', needs: 'verification' },
    ],
  },
  {
    id: 'settings',
    labelKey: 'admin_group_settings',
    icon: UserCog,
    items: [
      { id: 'company', code: 'ADMIN_COMPANY_PROFILE', labelKey: 'admin_nav_company', icon: Building2 },
      { id: 'roles', code: 'ADMIN_ROLES', labelKey: 'admin_nav_roles', icon: ShieldHalf, needs: 'roles' },
      { id: 'screens', code: 'ADMIN_SCREENS', labelKey: 'admin_nav_screens', icon: LayoutGrid },
      { id: 'notifications', code: 'ADMIN_NOTIFICATIONS', labelKey: 'admin_nav_notifications', icon: BellRing },
      { id: 'support', code: 'ADMIN_SUPPORT', labelKey: 'admin_nav_support', icon: LifeBuoy, module: 'SUPPORT', needs: 'support' },
      { id: 'audit', code: 'ADMIN_AUDIT', labelKey: 'admin_nav_audit', icon: History, basic: true },
    ],
  },
];

const ALL_CODES = new Set(ADMIN_GROUPS.flatMap((group) => group.items.map((item) => item.code)));

/** Every section the address bar may legitimately name. */
export const ADMIN_SECTION_IDS = new Set(
  ADMIN_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
);

const OPEN_GROUPS_KEY = 'bbnovix_admin_open_groups';

const readOpenGroups = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || 'null');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeOpenGroups = (groups) => {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // A blocked storage only costs the memory of which group was open.
  }
};

/**
 * Filters the model down to what this account may actually open.
 *
 * @param {{roleCode: string, available: Set<string>}} input
 *        `available` is the set of section ids the admin centre can render,
 *        so a screen owned by a module that is not installed disappears rather
 *        than opening onto an error.
 */
export const useAdminNavigation = ({ roleCode, available }) => {
  const { isModuleAllowed } = useTenant();
  const [allowedCodes, setAllowedCodes] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadMyScreens().then(({ data }) => {
      if (cancelled || !data?.length) return;
      const codes = new Set(data.map((screen) => screen.code));
      // Only trust the answer when it actually knows about admin screens; an
      // older database would otherwise hide the whole tab.
      if ([...ALL_CODES].some((code) => codes.has(code))) setAllowedCodes(codes);
    });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const fullAdmin = roleCode === 'PLATFORM_ADMIN' || roleCode === 'PLATFORM_OPERATOR';
    const screenAllowed = (item) => {
      if (allowedCodes) return allowedCodes.has(item.code);
      return fullAdmin || Boolean(item.basic);
    };

    return ADMIN_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => (
          available.has(item.id) && isModuleAllowed(item.module) && screenAllowed(item)
        )),
      }))
      .filter((group) => group.items.length > 0);
  }, [roleCode, available, allowedCodes, isModuleAllowed]);
};

// ---------------------------------------------------------------------------

const GroupCaret = ({ open }) => {
  const { isRtl } = useLanguage();
  if (open) return <ChevronDown className="admin-nav-caret" aria-hidden="true" />;
  const Icon = isRtl ? ChevronLeft : ChevronRight;
  return <Icon className="admin-nav-caret" aria-hidden="true" />;
};

const AdminNav = ({ groups, section, onSelect }) => {
  const { t } = useLanguage();
  const [openGroups, setOpenGroups] = useState(() => readOpenGroups());

  const activeGroup = groups.find((group) => group.items.some((item) => item.id === section))?.id || null;

  // Nothing has been collapsed yet: everything is open, which is how a person
  // discovers what the tab contains.
  const isOpen = (group) => (openGroups ? openGroups.includes(group.id) : true) || group.id === activeGroup;

  const toggleGroup = (group) => {
    const current = openGroups || groups.map((item) => item.id);
    const next = current.includes(group.id)
      ? current.filter((id) => id !== group.id)
      : [...current, group.id];
    setOpenGroups(next);
    writeOpenGroups(next);
  };

  if (!groups.length) {
    return (
      <aside className="admin-sidebar admin-sidebar-grouped">
        <p className="admin-nav-empty">{t('admin_no_screens')}</p>
      </aside>
    );
  }

  return (
    <aside className="admin-sidebar admin-sidebar-grouped">
      <div>
        <span>{t('admin_console_subtitle')}</span>
        <strong>{t('admin_console')}</strong>
      </div>

      <nav aria-label={t('admin_navigation')}>
        {groups.map((group) => {
          const open = isOpen(group);
          const GroupIcon = group.icon;
          return (
            <section className="admin-nav-group" key={group.id}>
              <button
                type="button"
                className="admin-nav-group-head"
                aria-expanded={open}
                aria-controls={`admin-group-${group.id}`}
                aria-label={t(open ? 'admin_collapse_group' : 'admin_expand_group', { group: t(group.labelKey) })}
                onClick={() => toggleGroup(group)}
              >
                <GroupIcon aria-hidden="true" />
                <span>{t(group.labelKey)}</span>
                <GroupCaret open={open} />
              </button>

              <div className="admin-nav-items" id={`admin-group-${group.id}`} hidden={!open}>
                {group.items.map((item) => {
                  const ItemIcon = item.icon;
                  const active = item.id === section;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={active ? 'active' : ''}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSelect(item)}
                    >
                      <ItemIcon aria-hidden="true" />
                      <span>{t(item.labelKey)}</span>
                      {item.href && (
                        <ExternalLink className="admin-nav-external" aria-label={t('admin_open_in_new_screen')} />
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </nav>

      <div className="admin-version">
        <UserCog aria-hidden="true" />
        <div>
          <b>{t('administrator_mode')}</b>
          <small>{t('enterprise_edition')}</small>
        </div>
      </div>
    </aside>
  );
};

export default AdminNav;
