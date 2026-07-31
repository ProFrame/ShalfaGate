import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BarChart3, BookOpenCheck, BriefcaseBusiness, Building2, Check, CircleGauge,
  Download, ExternalLink, FileStack, Filter, Goal, History, Pencil, Plus, Search, Settings2,
  ShieldCheck, SlidersHorizontal, Trash2, Upload, UserCog, Users, X
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip,
  XAxis, YAxis
} from 'recharts';
import readXlsxFile from 'read-excel-file/browser';
import writeXlsxFile from 'write-excel-file/browser';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { supabase, useLocalData } from '../lib/supabaseClient';
import { deleteContentItem, loadManagedContent, saveContentItem } from '../data/contentService';
import { loadLibrary, saveLibraryItem } from '../data/performanceLibraryService';
import { loadOrganizationLookups, saveOrganizationItem } from '../data/organizationService';
import { ApprovalSetupAdmin, ApprovalTrackingAdmin } from './ApprovalAdmin';

const ROLE_OPTIONS = [
  { value: 'Employee', key: 'role_employee' },
  { value: 'Department Coordinator', key: 'role_department_coordinator' },
  { value: 'Department Manager', key: 'role_department_manager' },
  { value: 'System Administrator', key: 'role_system_administrator' },
  { value: 'Platform Administrator', key: 'role_platform_administrator' },
];

const roleKey = (role = '') => ROLE_OPTIONS.find((item) => (
  item.value === role || item.value.toUpperCase().replaceAll(' ', '_') === role
))?.key || 'role_employee';

const navItems = [
  { id: 'employees', labelKey: 'employees', icon: Users },
  { id: 'departments', labelKey: 'departments', icon: Building2 },
  { id: 'positions', labelKey: 'positions', icon: BriefcaseBusiness },
  { id: 'content', labelKey: 'content_management', icon: FileStack },
  { id: 'cycles', labelKey: 'evaluation_cycles', icon: Activity },
  { id: 'goals', labelKey: 'goal_library', icon: Goal },
  { id: 'competencies', labelKey: 'competency_library', icon: BookOpenCheck },
  { id: 'proficiency', labelKey: 'proficiency_levels', icon: CircleGauge },
  { id: 'approval_setup', labelKey: 'approval_setup', icon: Settings2 },
  { id: 'approval_tracking', labelKey: 'approval_tracking', icon: Activity },
  { id: 'analytics', labelKey: 'performance_dashboard', icon: BarChart3 },
  { id: 'audit', labelKey: 'audit_log', icon: History },
];

const downloadWorkbook = (rows, columns, fileName) => (
  writeXlsxFile(rows, { columns }).toFile(fileName)
);

const readFirstWorksheet = async (file) => {
  const workbook = await readXlsxFile(file);
  if (Array.isArray(workbook?.[0]?.data)) return workbook[0].data;
  return workbook;
};

const seedEmployees = [
  { id: 1, employee_no: '10001', full_name: 'أحمد محمد', email: 'ahmed@shalfa.com.sa', mobile: '0500000001', department: 'الموارد البشرية', job_title: 'أخصائي موارد بشرية', role: 'Platform Administrator', active: true },
  { id: 2, employee_no: '10024', full_name: 'سارة خالد', email: 'sara@shalfa.com.sa', mobile: '0500000002', department: 'المالية', job_title: 'محاسب أول', role: 'Employee', active: true },
  { id: 3, employee_no: '10113', full_name: 'محمد علي', email: 'm.ali@shalfa.com.sa', mobile: '0500000003', department: 'التشغيل', job_title: 'مدير مشروع', role: 'Department Manager', active: true },
  { id: 4, employee_no: '10208', full_name: 'نورة حسن', email: 'noura@shalfa.com.sa', mobile: '0500000004', department: 'تقنية المعلومات', job_title: 'محلل نظم', role: 'Employee', active: false },
];

const seedGoals = [
  { code: 'OPS-001', category: 'تشغيلي', title: 'رفع الالتزام بمستوى الخدمة', measurement: 'نسبة SLA', formula: 'المحقق / المستهدف × 100', departments: 'التشغيل', default_weight: 25, active: true },
  { code: 'FIN-001', category: 'مالي', title: 'خفض تكلفة التشغيل', measurement: 'نسبة الخفض', formula: '(الأساس - الفعلي) / الأساس', departments: 'المالية، التشغيل', default_weight: 20, active: true },
  { code: 'SAF-001', category: 'السلامة', title: 'تحسين الامتثال للسلامة', measurement: 'نسبة الامتثال', formula: 'النقاط المحققة / الكلية', departments: 'جميع الإدارات', default_weight: 25, active: true },
];

const seedCompetencies = [
  { code: 'CORE-001', category: 'أساسية', parent: 'التواصل', title: 'التواصل الفعال', definition: 'نقل واستقبال المعلومات بوضوح واحترافية.', indicators: 5, departments: 'جميع الإدارات', jobs: 'جميع الوظائف', level: 3, active: true },
  { code: 'CORE-002', category: 'أساسية', parent: 'التعاون', title: 'العمل الجماعي', definition: 'التعاون مع الآخرين لتحقيق أهداف مشتركة.', indicators: 5, departments: 'جميع الإدارات', jobs: 'جميع الوظائف', level: 3, active: true },
  { code: 'FIN-001', category: 'وظيفية', parent: 'المالية', title: 'المحاسبة المالية', definition: 'تسجيل وتصنيف وتلخيص العمليات وفق المعايير المعتمدة.', indicators: 5, departments: 'المالية', jobs: 'محاسب، محاسب أول', level: 4, active: true },
  { code: 'FIN-004', category: 'وظيفية', parent: 'المالية', title: 'التسويات البنكية', definition: 'إجراء التسويات وتحليل الفروقات بدقة.', indicators: 5, departments: 'المالية', jobs: 'محاسب، أمين خزينة', level: 3, active: true },
];

const departmentScores = [
  { name: 'التطوير المؤسسي', score: 4.02, completion: 100 },
];

const competencyRadar = [
  { subject: 'التواصل', score: 4.1 }, { subject: 'العمل الجماعي', score: 4.3 },
  { subject: 'التخطيط', score: 3.5 }, { subject: 'الابتكار', score: 3.2 },
  { subject: 'القيادة', score: 3.8 }, { subject: 'خدمة العميل', score: 4.0 },
];

const trend = [
  { period: 'Q1 25', score: 3.62 }, { period: 'Q2 25', score: 3.71 }, { period: 'Q3 25', score: 3.78 },
  { period: 'Q4 25', score: 3.84 }, { period: 'Q1 26', score: 3.92 }, { period: 'Q2 26', score: 4.01 },
];

const Analytics = () => {
  const { t, lang } = useLanguage();
  const [cycles, setCycles] = useState([]);
  const [cycleId, setCycleId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [departmentId, setDepartmentId] = useState('');
  const [insightOpen, setInsightOpen] = useState(false);
  const [evaluations, setEvaluations] = useState(() => useLocalData ? departmentScores.map((row, index) => ({
    id: index, overall_score: row.score, status: index % 4 ? 'Submitted' : 'Draft',
    department_id: row.name, department_name: row.name,
  })) : []);

  useEffect(() => {
    const loadCycles = async () => {
      if (useLocalData) {
        const preview = [
          { id: 'annual-2026', name_ar: 'التقييم السنوي 2026', name_en: 'Annual Review 2026' },
          { id: 'q1-2026', name_ar: 'التقييم الربع سنوي الأول 2026', name_en: 'Q1 Review 2026' },
        ];
        setCycles(preview);
        setCycleId(preview[0].id);
        return;
      }
      const { data } = await supabase.from('evaluation_cycles').select('id,name_ar,name_en').eq('is_deleted', false).order('start_date', { ascending: false });
      setCycles(data || []);
      setCycleId((current) => current || data?.[0]?.id || '');
    };
    loadCycles();
    loadOrganizationLookups().then((data) => setDepartments(data.departments)).catch(() => setDepartments([]));
  }, []);
  useEffect(() => {
    if (useLocalData) {
      return;
    }
    let query = supabase.from('performance_evaluations')
      .select('id,overall_score,workflow_status,evaluation_cycle_id,department_id,departments(id,name_ar,name_en),evaluation_cycles(end_date)')
      .eq('is_deleted', false);
    if (cycleId) query = query.eq('evaluation_cycle_id', cycleId);
    if (departmentId) query = query.eq('department_id', departmentId);
    query.then(({ data }) => setEvaluations((data || []).map((row) => ({
      ...row,
      status: row.workflow_status,
      department_name: lang === 'ar' ? row.departments?.name_ar : row.departments?.name_en || row.departments?.name_ar,
    }))));
  }, [cycleId, departmentId, lang]);
  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId);
  const selectedCycleName = selectedCycle ? (lang === 'ar' ? selectedCycle.name_ar : selectedCycle.name_en || selectedCycle.name_ar) : t('all_cycles');
  const filtered = useLocalData && departmentId ? evaluations.filter((row) => row.department_id === departmentId) : evaluations;
  const scores = filtered.map((row) => Number(row.overall_score)).filter((score) => Number.isFinite(score) && score > 0);
  const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  const ordered = [...scores].sort((a, b) => a - b);
  const medianValue = ordered.length ? (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.ceil((ordered.length - 1) / 2)]) / 2 : 0;
  const deviation = scores.length ? Math.sqrt(scores.reduce((sum, score) => sum + ((score - average) ** 2), 0) / scores.length) : 0;
  const departmentChart = Object.values(filtered.reduce((result, row) => {
    const key = row.department_id || 'unassigned';
    result[key] ||= { name: row.department_name || t('not_assigned'), total: 0, count: 0 };
    if (Number(row.overall_score) > 0) { result[key].total += Number(row.overall_score); result[key].count += 1; }
    return result;
  }, {})).map((row) => ({ ...row, score: row.count ? Number((row.total / row.count).toFixed(2)) : 0 }));
  const distributionData = [
    { range: '1-1.49', count: scores.filter((v) => v < 1.5).length },
    { range: '1.5-2.49', count: scores.filter((v) => v >= 1.5 && v < 2.5).length },
    { range: '2.5-3.49', count: scores.filter((v) => v >= 2.5 && v < 3.5).length },
    { range: '3.5-4.49', count: scores.filter((v) => v >= 3.5 && v < 4.5).length },
    { range: '4.5-5', count: scores.filter((v) => v >= 4.5).length },
  ];
  const completed = filtered.filter((row) => row.status && row.status !== 'Draft').length;
  const rankedDepartments = [...departmentChart].filter((row) => row.count).sort((a, b) => b.score - a.score);
  const highestDepartment = rankedDepartments[0];
  const lowestDepartment = rankedDepartments[rankedDepartments.length - 1];
  const insightText = !rankedDepartments.length
    ? t('analytics_no_results')
    : rankedDepartments.length === 1
      ? t('analytics_single_department', { department: highestDepartment.name, count: highestDepartment.count, score: highestDepartment.score.toFixed(2) })
      : t('analytics_department_comparison', {
          highest: highestDepartment.name,
          highScore: highestDepartment.score.toFixed(2),
          lowest: lowestDepartment.name,
          lowScore: lowestDepartment.score.toFixed(2),
        });
  const today = new Date().toISOString().slice(0, 10);
  const overdue = filtered.filter((row) => row.status === 'Draft' && row.evaluation_cycles?.end_date && row.evaluation_cycles.end_date < today);
  const overdueByDepartment = Object.values(overdue.reduce((result, row) => {
    const key = row.department_id || 'unassigned';
    result[key] ||= { name: row.department_name || t('not_assigned'), count: 0 };
    result[key].count += 1;
    return result;
  }, {})).sort((a, b) => b.count - a.count);
  return (
  <div className="admin-content">
    <div className="admin-toolbar">
      <div><span className="section-kicker">{t('executive_management')}</span><h1>{t('performance_analytics')}</h1><p>{t('analytics_intro')}</p></div>
      <div className="filter-cluster"><select className="filter-button" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">{t('all_departments')}</option>{departments.filter((row) => row.is_active).map((row) => <option key={row.id} value={useLocalData ? row.name_ar : row.id}>{lang === 'ar' ? row.name_ar : row.name_en || row.name_ar}</option>)}</select><select className="filter-button" value={cycleId} onChange={(event) => setCycleId(event.target.value)}><option value="">{t('all_cycles')}</option>{cycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{lang === 'ar' ? cycle.name_ar : cycle.name_en || cycle.name_ar}</option>)}</select><button className="icon-button"><Download /></button></div>
    </div>
    <div className="kpi-grid">
      <Kpi label={t('average_performance')} value={average.toFixed(2)} change="" hint={selectedCycleName} tone="emerald" />
      <Kpi label={t('median')} value={medianValue.toFixed(2)} change="" hint={t('score_distribution')} tone="blue" />
      <Kpi label={t('standard_deviation')} value={deviation.toFixed(2)} change="" hint={t('performance_trend')} tone="amber" />
      <Kpi label={t('completion_rate')} value={`${filtered.length ? Math.round((completed / filtered.length) * 100) : 0}%`} change={`${completed} / ${filtered.length}`} hint={t('evaluation_cycles')} tone="rose" />
    </div>
    <div className="analytics-grid">
      <ChartPanel title={t('department_performance')} subtitle={t('analytics_intro')} wide>
        <ResponsiveContainer width="100%" height={290}><BarChart data={departmentChart} margin={{ top: 10, right: 0, left: -18, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" /><XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 12 }} /><YAxis domain={[0, 5]} tick={{ fill: 'var(--muted)', fontSize: 12 }} /><Tooltip /><Bar dataKey="score" radius={[4, 4, 0, 0]}>{departmentChart.map((row) => <Cell key={row.name} fill={row.score >= 4 ? '#1b4f82' : row.score < 3.6 ? '#d97706' : '#3b82f6'} />)}</Bar></BarChart></ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title={t('score_distribution')} subtitle={t('completed_requests')}>
        <ResponsiveContainer width="100%" height={290}><PieChart><Pie data={distributionData} dataKey="count" nameKey="range" innerRadius={64} outerRadius={100} paddingAngle={3}>{['#dc2626','#d97706','#6b9fd1','#2f6fa9','#12365d'].map((color) => <Cell key={color} fill={color} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title={t('performance_trend')} subtitle={t('last_updated')}>
        <ResponsiveContainer width="100%" height={260}><LineChart data={trend}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" /><XAxis dataKey="period" tick={{ fill: 'var(--muted)' }} /><YAxis domain={[3, 5]} tick={{ fill: 'var(--muted)' }} /><Tooltip /><Line type="monotone" dataKey="score" stroke="#1b4f82" strokeWidth={3} dot={{ r: 4, fill: '#1b4f82' }} /></LineChart></ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title={t('competency_profile')} subtitle={t('competency_library')}>
        <ResponsiveContainer width="100%" height={260}><RadarChart data={competencyRadar}><PolarGrid stroke="var(--line)" /><PolarAngleAxis dataKey="subject" tick={{ fill: 'var(--muted)', fontSize: 11 }} /><Radar dataKey="score" stroke="#1b4f82" fill="#1b4f82" fillOpacity={0.2} /></RadarChart></ResponsiveContainer>
      </ChartPanel>
    </div>
    <div className="insight-row">
      <div className="risk-insight"><Activity /><div><b>{t('analytics_review_note')}</b><p>{insightText}</p></div><button onClick={() => setInsightOpen(true)} disabled={!rankedDepartments.length}>{t('open_variance_analysis')}</button></div>
      <div className="completion-summary"><strong>{overdue.length}</strong><span>{t('overdue_evaluations')}</span><small>{overdueByDepartment[0] ? t('highest_delay_department', { department: overdueByDepartment[0].name }) : t('no_overdue_evaluations')}</small></div>
    </div>
    {insightOpen && <div className="modal-backdrop" onClick={() => setInsightOpen(false)}><div className="modal-card modal-wide" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><h3>{t('variance_analysis')}</h3><button className="icon-button" onClick={() => setInsightOpen(false)}><X /></button></div><div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th>{t('department')}</th><th>{t('evaluations_count')}</th><th>{t('average_performance')}</th><th>{t('variance_from_average')}</th></tr></thead><tbody>{rankedDepartments.map((row) => <tr key={row.name}><td><b>{row.name}</b></td><td>{row.count}</td><td>{row.score.toFixed(2)}</td><td>{(row.score - average).toFixed(2)}</td></tr>)}</tbody></table></div></div></div>}
  </div>
  );
};

const Kpi = ({ label, value, change, hint, tone }) => <div className={`kpi-item kpi-${tone}`}><span>{label}</span><div><strong>{value}</strong><b>{change}</b></div><small>{hint}</small></div>;
const ChartPanel = ({ title, subtitle, wide, children }) => <section className={`chart-panel ${wide ? 'chart-wide' : ''}`}><div><h3>{title}</h3><p>{subtitle}</p></div>{children}</section>;

const Employees = () => {
  const { t, lang } = useLanguage();
  const fileRef = useRef();
  const [employees, setEmployees] = useState(seedEmployees);
  const [lookups, setLookups] = useState({ departments: [], positions: [] });
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('success');
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const mapEmployees = (rows) => rows.map((row) => ({
    ...row,
    department: row.departments?.name_ar || row.department || '',
    job_title: row.positions?.name_ar || row.job_title || '',
    role: row.user_roles?.[0]?.roles?.name_en || 'Employee',
    active: row.is_active,
  }));

  const reloadEmployees = async () => {
    if (useLocalData) return;
    const { data, error } = await supabase
      .from('users')
      .select('*, departments(id,code,name_ar,name_en), positions(id,code,name_ar,name_en), user_roles(role_id, roles(code, name_en))')
      .eq('is_deleted', false)
      .order('full_name');
    if (error) throw error;
    setEmployees(mapEmployees(data));
  };

  useEffect(() => {
    let cancelled = false;
    loadOrganizationLookups()
      .then((data) => { if (!cancelled) setLookups(data); })
      .catch(() => { if (!cancelled) setLookups({ departments: [], positions: [] }); });
    if (!useLocalData) {
      supabase
        .from('users')
        .select('*, departments(id,code,name_ar,name_en), positions(id,code,name_ar,name_en), user_roles(role_id, roles(code, name_en))')
        .eq('is_deleted', false)
        .order('full_name')
        .then(({ data, error }) => {
          if (!cancelled && !error) setEmployees(mapEmployees(data));
          if (!cancelled && error) {
            setEmployees([]);
            setNoticeTone('error');
            setNotice(t('employees_load_failed'));
          }
        });
    }
    return () => { cancelled = true; };
  }, [t]);

  const visible = employees.filter((row) => `${row.employee_no} ${row.full_name} ${row.email} ${row.department}`.toLowerCase().includes(search.toLowerCase()));
  const employeeConflict = (candidate) => {
    const email = String(candidate.email || '').trim().toLowerCase();
    const employeeNo = String(candidate.employee_no || '').trim();
    const emailOwner = employees.find((row) => row.id !== candidate.id && String(row.email || '').trim().toLowerCase() === email);
    if (emailOwner) return t('employee_email_conflict', { number: emailOwner.employee_no });
    const numberOwner = employees.find((row) => row.id !== candidate.id && String(row.employee_no || '').trim() === employeeNo);
    if (numberOwner) return t('employee_number_conflict', { name: numberOwner.full_name });
    return '';
  };

  const employeeErrorMessage = (error) => {
    const message = error?.context?.body?.error || error?.message || String(error);
    if (message.includes('EMAIL_ALREADY_USED') || message.includes('already been registered')) return t('email_already_used');
    if (message.includes('EMPLOYEE_NUMBER_ALREADY_USED')) return t('employee_number_already_used');
    if (message.includes('MISSING_REQUIRED_DATA')) return t('employee_required_data');
    if (message.includes('FUNCTION_NOT_FOUND') || message.includes('Failed to send a request')) return t('employee_service_unavailable');
    if (message.includes('FORBIDDEN')) return t('permission_denied');
    return t('operation_failed');
  };

  const importFile = async (file) => {
    const rows = await readFirstWorksheet(file);
    const [headers, ...body] = rows;
    const keys = headers.map((cell) => String(cell || '').trim().toLowerCase());
    const parsed = body.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(keys.map((key, col) => [key, row[col]])));
    const errors = [];
    let create = 0;
    let update = 0;
    parsed.forEach((row, index) => {
      const email = String(row.email || '').toLowerCase();
      const employeeNo = String(row.employee_no || row.employeeno || '');
      if (!email || !employeeNo || !row.full_name) errors.push(`الصف ${index + 2}: بيانات أساسية ناقصة`);
      else if (parsed.some((other, otherIndex) => otherIndex !== index && String(other.email || '').toLowerCase() === email)) errors.push(`الصف ${index + 2}: البريد مكرر داخل الملف`);
      else {
        const byEmail = employees.find((item) => item.email.toLowerCase() === email);
        const byNumber = employees.find((item) => String(item.employee_no) === employeeNo);
        if (byEmail && byNumber && byEmail.id !== byNumber.id) errors.push(`الصف ${index + 2}: البريد والرقم الوظيفي يعودان لموظفين مختلفين`);
        else if (byEmail && !byNumber) errors.push(`الصف ${index + 2}: البريد مستخدم لموظف آخر`);
        else if (byNumber || byEmail) update += 1;
        else create += 1;
      }
    });
    setPreview({ rows: parsed, create, update, errors });
  };

  const exportEmployees = async () => {
    const columns = [
      { header: 'Employee No', type: String, cell: (row) => row.employee_no || '' },
      { header: 'Full Name', type: String, cell: (row) => row.full_name || '' },
      { header: 'Email', type: String, cell: (row) => row.email || '' },
      { header: 'Mobile', type: String, cell: (row) => row.mobile || '' },
      { header: 'Department Code', type: String, cell: (row) => row.departments?.code || '' },
      { header: 'Department', type: String, cell: (row) => row.department || '' },
      { header: 'Position Code', type: String, cell: (row) => row.positions?.code || '' },
      { header: 'Job Title', type: String, cell: (row) => row.job_title || '' },
      { header: 'Role', type: String, cell: (row) => row.role || 'Employee' },
      { header: 'Active', type: Boolean, cell: (row) => row.active !== false },
    ];
    const exportRows = selectedIds.size
      ? employees.filter((row) => selectedIds.has(row.id))
      : visible;
    try {
      await downloadWorkbook(exportRows, columns, `ShalfaGate-Employees-${new Date().toISOString().slice(0, 10)}.xlsx`);
      setNoticeTone('success');
      setNotice(t('employees_exported', { count: exportRows.length }));
    } catch {
      setNoticeTone('error');
      setNotice(t('export_failed'));
    }
  };

  const persistEmployee = async (employee) => {
    if (useLocalData) return;
    const { data, error } = await supabase.functions.invoke('invite-employee', {
      body: {
        userId: employee.id || null,
        email: employee.email.trim().toLowerCase(),
        employeeNo: employee.employee_no,
        fullName: employee.full_name,
        nameAr: employee.name_ar || employee.full_name,
        nameEn: employee.name_en || null,
        mobile: employee.mobile,
        department: employee.department,
        departmentId: employee.department_id || null,
        jobTitle: employee.job_title,
        positionId: employee.position_id || null,
        role: employee.role,
        active: employee.active,
        redirectTo: `${window.location.origin}${window.location.pathname}?auth_action=set-password`,
      },
    });
    if (error) {
      let functionMessage = '';
      try {
        functionMessage = (await error.context?.clone?.().json())?.error || '';
      } catch {
        // The generic client error is still useful when the response has no JSON body.
      }
      throw new Error(functionMessage || error.message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const confirmImport = async () => {
    const next = [...employees];
    preview.rows.forEach((row) => {
      const normalized = {
        employee_no: String(row.employee_no || row.employeeno || ''),
        full_name: String(row.full_name || ''),
        email: String(row.email || '').toLowerCase(),
        mobile: String(row.mobile || ''),
        department: String(row.department || ''),
        department_id: lookups.departments.find((item) => (
          String(item.code).toLowerCase() === String(row.department_code || '').toLowerCase()
          || item.name_ar === row.department
          || item.name_en === row.department
        ))?.id || null,
        job_title: String(row.job_title || ''),
        position_id: lookups.positions.find((item) => (
          String(item.code).toLowerCase() === String(row.position_code || '').toLowerCase()
          || item.name_ar === row.job_title
          || item.name_en === row.job_title
        ))?.id || null,
        role: String(row.role || 'Employee'),
        active: row.active !== false,
      };
      const index = next.findIndex((item) => item.email.toLowerCase() === normalized.email || item.employee_no === normalized.employee_no);
      if (index >= 0) next[index] = { ...next[index], ...normalized };
      else next.push({ ...normalized, id: crypto.randomUUID() });
    });
    if (useLocalData) {
      setEmployees(next);
      setPreview(null);
      return;
    }
    try {
      for (const employee of next) {
        const original = employees.find((row) => row.id === employee.id);
        if (!original || JSON.stringify(original) !== JSON.stringify(employee)) await persistEmployee(employee);
      }
      await reloadEmployees();
      setPreview(null);
      setNoticeTone('success');
      setNotice(t('employees_imported'));
    } catch (error) {
      setNoticeTone('error');
      setNotice(employeeErrorMessage(error));
    }
  };

  const saveEmployee = async (value) => {
    try {
      const normalized = {
        ...value,
        employee_no: String(value.employee_no || '').trim(),
        email: String(value.email || '').trim().toLowerCase(),
      };
      const conflict = employeeConflict(normalized);
      if (conflict) {
        return { error: conflict };
      }
      let result = { invited: false };
      if (useLocalData) {
        setEmployees((current) => normalized.id ? current.map((row) => row.id === normalized.id ? normalized : row) : [{ ...normalized, id: crypto.randomUUID() }, ...current]);
      } else {
        result = await persistEmployee(normalized);
        await reloadEmployees();
      }
      setEditing(null);
      setNoticeTone('success');
      setNotice(normalized.id ? t('employee_updated') : result?.invited ? t('employee_invited') : t('employee_created'));
      return { error: null };
    } catch (error) {
      return { error: employeeErrorMessage(error) };
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((row) => selectedIds.has(row.id));
  const toggleAllVisible = (checked) => setSelectedIds((current) => {
    const next = new Set(current);
    visible.forEach((row) => checked ? next.add(row.id) : next.delete(row.id));
    return next;
  });
  const toggleSelected = (id, checked) => setSelectedIds((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });

  return (
    <div className="admin-content">
      <div className="admin-toolbar"><div><span className="section-kicker">إدارة الهوية الوظيفية</span><h1>الموظفون</h1><p>إضافة الموظفين، تفعيل الحسابات وتعيين الأدوار من سجل واحد.</p></div><div className="toolbar-actions"><button className="secondary-button" onClick={exportEmployees}><Download /> تصدير Excel</button><button className="secondary-button" onClick={() => fileRef.current.click()}><Upload /> استيراد Excel</button><input ref={fileRef} hidden type="file" accept=".xlsx" onChange={(e) => e.target.files[0] && importFile(e.target.files[0])} /><button className="primary-button" onClick={() => setEditing({ active: true, role: 'Employee' })}><Plus /> إضافة موظف</button></div></div>
      {notice && <div className={`inline-message ${noticeTone === 'error' ? 'error' : ''}`}>{noticeTone === 'error' ? <X /> : <Check />}{notice}<button onClick={() => setNotice('')}><X /></button></div>}
      <div className="data-controls"><div className="search-control"><Search /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم، الرقم الوظيفي أو البريد..." /></div><button className="filter-button"><Filter /> جميع الإدارات</button><button className="filter-button"><SlidersHorizontal /> الحالة والدور</button><span className="result-count">{visible.length} موظفين</span></div>
      <div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th><input type="checkbox" aria-label={t('select_all')} checked={allVisibleSelected} onChange={(event) => toggleAllVisible(event.target.checked)} /></th><th>الموظف</th><th>الرقم الوظيفي</th><th>الإدارة / المسمى</th><th>الدور</th><th>الحساب</th><th /></tr></thead><tbody>{visible.map((row) => <tr key={row.id} className={selectedIds.has(row.id) ? 'selected-row' : ''}><td><input type="checkbox" aria-label={t('select_employee_row', { name: row.full_name })} checked={selectedIds.has(row.id)} onChange={(event) => toggleSelected(row.id, event.target.checked)} /></td><td><div className="employee-cell"><span className="mini-avatar">{row.full_name.split(' ').map((part) => part[0]).slice(0,2)}</span><div><b>{row.full_name}</b><small>{row.email}<br />{row.mobile}</small></div></div></td><td>{row.employee_no}</td><td><b>{row.department}</b><small>{row.job_title}</small></td><td><span className="role-badge">{t(roleKey(row.role))}</span></td><td><button onClick={async () => { const result = await saveEmployee({ ...row, active: !row.active }); if (result?.error) { setNoticeTone('error'); setNotice(result.error); } }} className={`toggle ${row.active ? 'active' : ''}`}><span /></button><small>{row.active ? t('active') : t('inactive')}</small></td><td><button className="icon-button" onClick={() => setEditing(row)}><Settings2 /></button></td></tr>)}</tbody></table></div>
      <div className="pagination"><button disabled>السابق</button><span className="active">1</span><span>2</span><span>3</span><button>التالي</button></div>
      {preview && <ImportPreview preview={preview} onClose={() => setPreview(null)} onConfirm={confirmImport} />}
      {editing && <EmployeeModal employee={editing} departments={lookups.departments} positions={lookups.positions} lang={lang} onClose={() => setEditing(null)} onSave={saveEmployee} />}
    </div>
  );
};

const ImportPreview = ({ preview, onClose, onConfirm }) => <div className="modal-backdrop"><div className="modal-card modal-wide"><div className="modal-heading"><div><span className="section-kicker">مراجعة قبل الحفظ</span><h3>نتيجة فحص ملف الموظفين</h3></div><button className="icon-button" onClick={onClose}><X /></button></div><div className="import-stats"><div><Plus /><b>{preview.create}</b><span>سجلات جديدة</span></div><div><Activity /><b>{preview.update}</b><span>سجلات ستُحدّث</span></div><div className={preview.errors.length ? 'has-errors' : ''}><X /><b>{preview.errors.length}</b><span>أخطاء</span></div></div>{preview.errors.length > 0 && <div className="validation-list">{preview.errors.slice(0, 6).map((error) => <p key={error}>{error}</p>)}</div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>إلغاء</button><button className="primary-button" disabled={preview.errors.length > 0} onClick={onConfirm}><Check /> تأكيد الاستيراد</button></div></div></div>;

const EmployeeModal = ({ employee, departments, positions, lang, onClose, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(employee);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await onSave(draft);
    if (result?.error) setError(result.error);
    setBusy(false);
  };
  const departmentOptions = departments.filter((item) => item.is_active || item.id === draft.department_id);
  const positionOptions = positions.filter((item) => (
    (item.is_active || item.id === draft.position_id)
    && (!draft.department_id || !item.department_id || item.department_id === draft.department_id)
  ));
  const label = (item) => (lang === 'ar' || lang === 'ur' ? item.name_ar : item.name_en || item.name_ar);
  const selectDepartment = (event) => {
    const item = departments.find((row) => row.id === event.target.value);
    setDraft({ ...draft, department_id: item?.id || null, department: item?.name_ar || '', position_id: null, job_title: '' });
  };
  const selectPosition = (event) => {
    const item = positions.find((row) => row.id === event.target.value);
    setDraft({ ...draft, position_id: item?.id || null, job_title: item?.name_ar || '' });
  };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal-card modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}><div className="modal-heading"><h3>{draft.id ? t('edit_employee') : t('add_employee')}</h3><button type="button" className="icon-button" onClick={onClose}><X /></button></div><div className="form-grid"><label className="field-label">{t('employee_number')}<input required className="form-input" value={draft.employee_no || ''} onChange={field('employee_no')} /></label><label className="field-label">{t('full_name')}<input required className="form-input" value={draft.full_name || ''} onChange={field('full_name')} /></label><label className="field-label">{t('work_email')}<input required type="email" className="form-input" value={draft.email || ''} onChange={field('email')} /></label><label className="field-label">{t('mobile')}<input className="form-input" value={draft.mobile || ''} onChange={field('mobile')} /></label><label className="field-label">{t('department')}<select className="form-input" value={draft.department_id || ''} onChange={selectDepartment}><option value="">{t('not_assigned')}</option>{departmentOptions.map((item) => <option key={item.id} value={item.id}>{item.code} · {label(item)}</option>)}</select></label><label className="field-label">{t('position')}<select className="form-input" value={draft.position_id || ''} onChange={selectPosition}><option value="">{t('not_assigned')}</option>{positionOptions.map((item) => <option key={item.id} value={item.id}>{item.code} · {label(item)}</option>)}</select></label><label className="field-label">{t('role')}<select className="form-input" value={draft.role || 'Employee'} onChange={field('role')}>{ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.key)}</option>)}</select></label><label className="field-label">{t('account_status')}<select className="form-input" value={String(draft.active)} onChange={(e) => setDraft({ ...draft, active: e.target.value === 'true' })}><option value="true">{t('active')}</option><option value="false">{t('inactive')}</option></select></label></div>{error && <div className="modal-error"><X />{error}</div>}<p className="field-note">{t('optional_organization_assignment')}</p><p className="field-note">{t('invitation_activation_note')}</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancelled')}</button><button className="primary-button" disabled={busy}>{busy ? t('saving') : t('save_employee')}</button></div></form></div>;
};

const Cycles = () => {
  const [cycles, setCycles] = useState([
    { code: 'APR-2026', name: 'التقييم السنوي 2026', start: '2026-01-01', end: '2026-12-31', target: 'جميع الموظفين', progress: 86, status: 'Active', self: true, manager: true },
    { code: 'Q2-ADM-2026', name: 'مراجعة الربع الثاني للإداريين', start: '2026-04-01', end: '2026-06-30', target: 'الوظائف الإدارية', progress: 100, status: 'Closed', self: false, manager: true },
    { code: 'PROB-2026', name: 'تقييم فترة التجربة', start: '2026-01-01', end: '2026-12-31', target: 'الموظفون الجدد', progress: 61, status: 'Active', self: true, manager: true },
  ]);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (useLocalData) return;
    let cancelled = false;
    supabase.from('evaluation_cycles').select('*').eq('is_deleted', false).order('start_date', { ascending: false }).then(({ data, error }) => {
      if (!cancelled && data) setCycles(data.map((cycle) => ({
        id: cycle.id, code: cycle.code, name: cycle.name_ar, start: cycle.start_date, end: cycle.end_date,
        target: cycle.target_department_ids?.length ? 'إدارات محددة' : 'جميع الموظفين',
        progress: 0, status: cycle.status, self: cycle.allow_self_evaluation, manager: cycle.allow_manager_evaluation,
      })));
      if (!cancelled && error) setNotice(error.message);
    });
    return () => { cancelled = true; };
  }, []);

  const saveCycle = async (cycle) => {
    if (useLocalData) {
      setCycles((current) => cycle.code && current.some((row) => row.code === cycle.code) ? current.map((row) => row.code === cycle.code ? cycle : row) : [cycle, ...current]);
      setEditing(null);
      return;
    }
    const payload = {
      code: cycle.code,
      name_ar: cycle.name,
      start_date: cycle.start,
      end_date: cycle.end,
      status: cycle.status,
      allow_self_evaluation: cycle.self,
      allow_manager_evaluation: cycle.manager,
      is_active: cycle.status === 'Active',
    };
    const { error } = await supabase.from('evaluation_cycles').upsert(payload, { onConflict: 'code' });
    if (error) {
      setNotice(error.message);
      return;
    }
    setNotice('تم حفظ دورة التقييم.');
    setEditing(null);
  };

  return <div className="admin-content"><div className="admin-toolbar"><div><span className="section-kicker">إدارة الأداء</span><h1>دورات التقييم</h1><p>تحديد نطاق وسياسة وفترة كل عملية تقييم ومنع التكرار لكل موظف.</p></div><button className="primary-button" onClick={() => setEditing({ status: 'Draft', self: true, manager: true })}><Plus /> دورة جديدة</button></div>{notice && <div className="inline-message"><Check />{notice}<button onClick={() => setNotice('')}><X /></button></div>}<div className="cycle-list">{cycles.map((cycle) => <article key={cycle.code} className="cycle-row"><div className={`cycle-mark ${cycle.status.toLowerCase()}`}><Activity /></div><div className="cycle-main"><div><span className="status-badge status-approved">{cycle.status === 'Active' ? 'نشطة' : cycle.status === 'Closed' ? 'مغلقة' : 'مسودة'}</span><code>{cycle.code}</code></div><h3>{cycle.name}</h3><p>{cycle.target} · {cycle.start} — {cycle.end}</p></div><div className="cycle-progress"><div><span>نسبة الإكمال</span><b>{cycle.progress}%</b></div><div className="progress-track"><span style={{ width: `${cycle.progress}%` }} /></div><small>{cycle.self ? 'تقييم ذاتي' : ''} {cycle.manager ? '· تقييم المدير' : ''}</small></div><button className="secondary-button" onClick={() => setEditing(cycle)}>إدارة الدورة</button></article>)}</div>{editing && <CycleModal cycle={editing} onClose={() => setEditing(null)} onSave={saveCycle} />}</div>;
};

const CycleModal = ({ cycle, onClose, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(cycle);
  return <div className="modal-backdrop" onClick={onClose}><form className="modal-card modal-wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(draft); }}><div className="modal-heading"><h3>إعداد دورة التقييم</h3><button type="button" className="icon-button" onClick={onClose}><X /></button></div><div className="form-grid"><AdminInput label="الكود" value={draft.code} onChange={(value) => setDraft({ ...draft, code: value })} required /><AdminInput label="اسم الدورة" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} required /><AdminInput label="تاريخ البداية" type="date" value={draft.start} onChange={(value) => setDraft({ ...draft, start: value })} required /><AdminInput label="تاريخ النهاية" type="date" value={draft.end} onChange={(value) => setDraft({ ...draft, end: value })} required /><AdminInput label="الفئة المستهدفة" value={draft.target} onChange={(value) => setDraft({ ...draft, target: value })} /><label className="field-label">الحالة<select className="form-input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}><option value="Draft">{t('draft')}</option><option value="Active">{t('active')}</option><option value="Closed">{t('closed_cycle')}</option></select></label></div><div className="check-grid"><label><input type="checkbox" checked={draft.self} onChange={(e) => setDraft({ ...draft, self: e.target.checked })} /> السماح بالتقييم الذاتي</label><label><input type="checkbox" checked={draft.manager} onChange={(e) => setDraft({ ...draft, manager: e.target.checked })} /> السماح بتقييم المدير</label><label><input type="checkbox" defaultChecked /> منع تكرار تقييم الموظف</label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>إلغاء</button><button className="primary-button">حفظ الدورة</button></div></form></div>;
};

const AdminInput = ({ label, value = '', onChange, type = 'text', required }) => <label className="field-label">{label}<input className="form-input" type={type} required={required} value={value || ''} onChange={(e) => onChange(e.target.value)} /></label>;

const normalizeLibraryRow = (kind, row) => {
  if (kind === 'goals') return {
    ...row, id: row.id || row.code, title: row.title_ar || row.title || row.goal, definition: row.description_ar || row.definition,
    measurement: row.measurement_unit_ar || row.measurement, formula: row.measurement_formula || row.formula,
    departments: Array.isArray(row.applicable_departments) ? row.applicable_departments.join('، ') : row.departments,
    jobs: Array.isArray(row.applicable_jobs) ? row.applicable_jobs.join('، ') : row.jobs,
    active: row.is_active ?? row.active ?? true,
  };
  return {
    ...row, id: row.id || row.code, title: row.name_ar || row.title || row.name, definition: row.definition_ar || row.definition,
    parent: row.parent || row.category, indicators: row.competency_indicators?.filter((item) => !item.is_deleted).length ?? row.indicators,
    departments: Array.isArray(row.applicable_departments) ? row.applicable_departments.join('، ') : row.departments,
    jobs: Array.isArray(row.applicable_jobs) ? row.applicable_jobs.join('، ') : row.jobs,
    level: row.default_level || row.level || 3, active: row.is_active ?? row.active ?? true,
  };
};

const LibraryModal = ({ kind, item, onClose, onSave }) => {
  const { t } = useLanguage();
  const goals = kind === 'goals';
  const existingIndicators = item.competency_indicators?.filter((row) => !row.is_deleted).map((row) => ({ text_ar: row.text_ar, text_en: row.text_en })) || item.indicator_rows || [];
  const [draft, setDraft] = useState({
    is_active: true, version: 1, default_weight: 0, ...item,
    title_ar: item.title_ar || (goals ? item.title : ''),
    title_en: item.title_en || (goals ? item.title : ''),
    name_ar: item.name_ar || (!goals ? item.title : ''),
    name_en: item.name_en || (!goals ? item.title : ''),
    description_ar: item.description_ar || (goals ? item.definition : ''),
    description_en: item.description_en || (goals ? item.definition : ''),
    definition_ar: item.definition_ar || (!goals ? item.definition : ''),
    definition_en: item.definition_en || (!goals ? item.definition : ''),
    measurement_unit_ar: item.measurement_unit_ar || item.measurement || '',
    measurement_unit_en: item.measurement_unit_en || item.measurement || '',
    measurement_formula: item.measurement_formula || item.formula || '',
    indicator_rows: existingIndicators,
  });
  const field = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  const setIndicator = (index, key, value) => setDraft((current) => ({ ...current, indicator_rows: current.indicator_rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row) }));
  return <div className="modal-backdrop" onClick={onClose}><form className="modal-card modal-xwide library-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
    <div className="modal-heading"><div><span className="section-kicker">{t(goals ? 'goal_library' : 'competency_library')}</span><h3>{item.id ? t('edit') : t('create')}</h3></div><button type="button" className="icon-button" onClick={onClose}><X /></button></div>
    <div className="form-grid">
      <label className="field-label">{t('code')}<input required className="form-input" value={draft.code || ''} onChange={field('code')} /></label>
      <label className="field-label">{t('category')}<input required className="form-input" value={draft.category || ''} onChange={field('category')} /></label>
      <label className="field-label">{t('name_arabic')}<input required className="form-input" value={(goals ? draft.title_ar : draft.name_ar) || ''} onChange={field(goals ? 'title_ar' : 'name_ar')} /></label>
      <label className="field-label">{t('name_english')}<input required className="form-input" value={(goals ? draft.title_en : draft.name_en) || ''} onChange={field(goals ? 'title_en' : 'name_en')} /></label>
      <label className="field-label field-span-2">{t('description_arabic')}<textarea className="form-input" value={(goals ? draft.description_ar : draft.definition_ar) || ''} onChange={field(goals ? 'description_ar' : 'definition_ar')} /></label>
      <label className="field-label field-span-2">{t('description_english')}<textarea className="form-input" value={(goals ? draft.description_en : draft.definition_en) || ''} onChange={field(goals ? 'description_en' : 'definition_en')} /></label>
      {goals ? <>
        <label className="field-label">{t('measurement_unit_ar')}<input className="form-input" value={draft.measurement_unit_ar || ''} onChange={field('measurement_unit_ar')} /></label>
        <label className="field-label">{t('measurement_unit_en')}<input className="form-input" value={draft.measurement_unit_en || ''} onChange={field('measurement_unit_en')} /></label>
        <label className="field-label">{t('measurement_formula')}<input className="form-input" value={draft.measurement_formula || ''} onChange={field('measurement_formula')} /></label>
        <label className="field-label">{t('target_formula')}<input className="form-input" value={draft.target_formula || ''} onChange={field('target_formula')} /></label>
        <label className="field-label">{t('frequency')}<input className="form-input" value={draft.frequency || ''} onChange={field('frequency')} /></label>
      </> : null}
      <label className="field-label">{t('applicable_departments')}<input className="form-input" value={draft.departments || ''} onChange={field('departments')} /></label>
      <label className="field-label">{t('applicable_jobs')}<input className="form-input" value={draft.jobs || ''} onChange={field('jobs')} /></label>
      <label className="field-label">{t('default_weight')}<input type="number" min="0" max="100" className="form-input" value={draft.default_weight || 0} onChange={field('default_weight')} /></label>
      <label className="field-label">{t('version')}<input type="number" min="1" className="form-input" value={draft.version || 1} onChange={field('version')} /></label>
    </div>
    {!goals && <div className="indicator-editor"><div className="indicator-editor-head"><div><b>{t('behavior_indicators')}</b><small>{t('behavior_indicators_help')}</small></div><button type="button" className="secondary-button" onClick={() => setDraft((current) => ({ ...current, indicator_rows: [...current.indicator_rows, { text_ar: '', text_en: '' }] }))}><Plus /> {t('add_indicator')}</button></div>{draft.indicator_rows.map((indicator, index) => <div className="indicator-row" key={index}><span>{index + 1}</span><input className="form-input" placeholder={t('arabic_text')} value={indicator.text_ar} onChange={(event) => setIndicator(index, 'text_ar', event.target.value)} /><input className="form-input" placeholder={t('english_text')} value={indicator.text_en} onChange={(event) => setIndicator(index, 'text_en', event.target.value)} /><button type="button" className="icon-button" onClick={() => setDraft((current) => ({ ...current, indicator_rows: current.indicator_rows.filter((_, rowIndex) => rowIndex !== index) }))}><Trash2 /></button></div>)}</div>}
    <label className="content-publish-check"><input type="checkbox" checked={draft.is_active ?? draft.active ?? true} onChange={(event) => setDraft({ ...draft, is_active: event.target.checked, active: event.target.checked })} /> {t('active')}</label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancelled')}</button><button className="primary-button">{t('save')}</button></div>
  </form></div>;
};

const LibraryTable = ({ kind }) => {
  const { t, lang } = useLanguage();
  const fileRef = useRef(null);
  const goals = kind === 'goals';
  const fallback = goals ? seedGoals : seedCompetencies;
  const [rows, setRows] = useState(fallback.map((row) => ({ ...row, id: row.code })));
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const refresh = async () => {
    try {
      const data = await loadLibrary(kind, fallback);
      setRows(data.map((row) => normalizeLibraryRow(kind, row)));
    } catch (error) { setNotice(error.message); }
  };
  useEffect(() => {
    let active = true;
    loadLibrary(kind, fallback)
      .then((data) => { if (active) setRows(data.map((row) => normalizeLibraryRow(kind, row))); })
      .catch((error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, [kind, fallback]);
  const visible = rows.filter((row) => `${row.code} ${row.title} ${row.title_en || row.name_en || ''} ${row.category}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const save = async (draft) => {
    const payload = goals ? {
      id: draft.id && draft.id !== draft.code ? draft.id : undefined, code: draft.code, category: draft.category,
      title_ar: draft.title_ar, title_en: draft.title_en, title: draft.title_en || draft.title_ar, goal: draft.title_en || draft.title_ar,
      description_ar: draft.description_ar, description_en: draft.description_en, description: draft.description_en || draft.description_ar,
      measurement_unit_ar: draft.measurement_unit_ar, measurement_unit_en: draft.measurement_unit_en,
      measurement_formula: draft.measurement_formula, formula: draft.measurement_formula, target_formula: draft.target_formula,
      frequency: draft.frequency, applicable_departments: String(draft.departments || '').split(/[,،]/).map((v) => v.trim()).filter(Boolean),
      applicable_jobs: String(draft.jobs || '').split(/[,،]/).map((v) => v.trim()).filter(Boolean),
      default_weight: Number(draft.default_weight || 0), version: Number(draft.version || 1), is_active: draft.is_active ?? true,
    } : {
      id: draft.id && draft.id !== draft.code ? draft.id : undefined, code: draft.code, category: draft.category,
      name_ar: draft.name_ar, name_en: draft.name_en, name: draft.name_en || draft.name_ar,
      definition_ar: draft.definition_ar, definition_en: draft.definition_en, definition: draft.definition_en || draft.definition_ar,
      description: draft.definition_en || draft.definition_ar,
      applicable_departments: String(draft.departments || '').split(/[,،]/).map((v) => v.trim()).filter(Boolean),
      applicable_jobs: String(draft.jobs || '').split(/[,،]/).map((v) => v.trim()).filter(Boolean),
      default_weight: Number(draft.default_weight || 0), version: Number(draft.version || 1), is_active: draft.is_active ?? true,
      indicators: draft.indicator_rows.filter((row) => row.text_ar || row.text_en),
    };
    try {
      await saveLibraryItem(kind, payload, rows);
      await refresh();
      setEditing(null);
      setNotice(t('saved_successfully'));
      return true;
    } catch (error) {
      setNotice(error.message || t('import_failed'));
      return false;
    }
  };
  const toggle = async (row) => save({ ...row, is_active: !row.active, indicator_rows: row.competency_indicators || [] });
  const exportRows = rows.length ? rows : [{}];
  const excelColumns = goals ? [
    { header: 'Code', type: String, cell: (row) => row.code || '' },
    { header: 'Category', type: String, cell: (row) => row.category || '' },
    { header: 'Arabic Title', type: String, cell: (row) => row.title_ar || row.title || '' },
    { header: 'English Title', type: String, cell: (row) => row.title_en || '' },
    { header: 'Arabic Description', type: String, cell: (row) => row.description_ar || row.definition || '' },
    { header: 'English Description', type: String, cell: (row) => row.description_en || '' },
    { header: 'Measurement Unit Arabic', type: String, cell: (row) => row.measurement_unit_ar || row.measurement || '' },
    { header: 'Measurement Unit English', type: String, cell: (row) => row.measurement_unit_en || '' },
    { header: 'Measurement Formula', type: String, cell: (row) => row.measurement_formula || row.formula || '' },
    { header: 'Target Formula', type: String, cell: (row) => row.target_formula || '' },
    { header: 'Frequency', type: String, cell: (row) => row.frequency || '' },
    { header: 'Applicable Departments', type: String, cell: (row) => row.departments || '' },
    { header: 'Applicable Jobs', type: String, cell: (row) => row.jobs || '' },
    { header: 'Default Weight', type: Number, cell: (row) => Number(row.default_weight || 0) },
    { header: 'Version', type: Number, cell: (row) => Number(row.version || 1) },
    { header: 'Active', type: Boolean, cell: (row) => row.active !== false },
  ] : [
    { header: 'Code', type: String, cell: (row) => row.code || '' },
    { header: 'Category', type: String, cell: (row) => row.category || '' },
    { header: 'Arabic Name', type: String, cell: (row) => row.name_ar || row.title || '' },
    { header: 'English Name', type: String, cell: (row) => row.name_en || row.title_en || '' },
    { header: 'Arabic Definition', type: String, cell: (row) => row.definition_ar || row.definition || '' },
    { header: 'English Definition', type: String, cell: (row) => row.definition_en || '' },
    { header: 'Behavior Indicators Arabic', type: String, cell: (row) => (row.competency_indicators || []).map((item) => item.text_ar).filter(Boolean).join('\n') },
    { header: 'Behavior Indicators English', type: String, cell: (row) => (row.competency_indicators || []).map((item) => item.text_en).filter(Boolean).join('\n') },
    { header: 'Applicable Departments', type: String, cell: (row) => row.departments || '' },
    { header: 'Applicable Jobs', type: String, cell: (row) => row.jobs || '' },
    { header: 'Default Weight', type: Number, cell: (row) => Number(row.default_weight || 0) },
    { header: 'Version', type: Number, cell: (row) => Number(row.version || 1) },
    { header: 'Active', type: Boolean, cell: (row) => row.active !== false },
  ];
  const readImport = async (file) => {
    setNotice(t('reading_excel_file'));
    try {
      const [headers, ...body] = await readFirstWorksheet(file);
      if (!headers?.length) throw new Error(t('excel_empty'));
      const keys = headers.map((value) => String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase());
      const records = body.filter((row) => row.some((cell) => cell !== null && cell !== '')).map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index]])));
      if (!records.length) throw new Error(t('excel_empty'));
      const mapped = records.map((row) => {
      const split = (value) => {
        const text = String(value || '').trim();
        if (!text) return [];
        const numbered = text.split(/(?=\d+\.\s*)/).map((item) => item.trim()).filter(Boolean);
        return numbered.length > 1 ? numbered : text.split(/\r?\n|\|/).map((item) => item.trim()).filter(Boolean);
      };
      const base = {
        code: String(row.code || '').trim(), category: row.category || '', default_weight: Number(row['default weight'] || 0),
        version: Number(row.version || 1), is_active: row.active !== false && String(row.active).toLowerCase() !== 'false',
        departments: row['applicable departments'] || '', jobs: row['applicable jobs'] || '',
      };
      if (goals) return { ...base, title_ar: row['arabic title'] || '', title_en: row['english title'] || '', description_ar: row['arabic description'] || '', description_en: row['english description'] || '', measurement_unit_ar: row['measurement unit arabic'] || '', measurement_unit_en: row['measurement unit english'] || '', measurement_formula: row['measurement formula'] || '', target_formula: row['target formula'] || '', frequency: row.frequency || '' };
      const ar = split(row['behavior indicators arabic']);
      const en = split(row['behavior indicators english']);
      return { ...base, name_ar: row['arabic name'] || '', name_en: row['english name'] || '', definition_ar: row['arabic definition'] || '', definition_en: row['english definition'] || '', indicator_rows: Array.from({ length: Math.max(ar.length, en.length) }, (_, i) => ({ text_ar: ar[i] || '', text_en: en[i] || '' })) };
      });
      const errors = mapped.flatMap((row, index) => (!row.code || !(goals ? row.title_ar : row.name_ar) ? [`${t('row')} ${index + 2}: ${t('required_fields')}`] : []));
      const existing = new Set(rows.map((row) => String(row.code).trim().toUpperCase()));
      setImportPreview({ fileName: file.name, rows: mapped, errors, additions: mapped.filter((row) => !existing.has(row.code.toUpperCase())).length, updates: mapped.filter((row) => existing.has(row.code.toUpperCase())).length });
      setNotice('');
    } catch (error) {
      setImportPreview(null);
      setNotice(`${t('import_failed')}: ${error.message || t('operation_failed')}`);
    }
  };
  const commitImport = async () => {
    if (!importPreview || importPreview.errors.length) return;
    setNotice(t('import_in_progress'));
    try {
      for (const row of importPreview.rows) {
        const saved = await save(row);
        if (!saved) throw new Error(t('import_failed'));
      }
      setImportPreview(null);
      await refresh();
      setNotice(t('import_completed'));
    } catch (error) {
      setNotice(error.message || t('import_failed'));
    }
  };
  return <div className="admin-content"><div className="admin-toolbar"><div><span className="section-kicker">{t('performance_management')}</span><h1>{t(goals ? 'smart_goal_bank' : 'competency_library')}</h1><p>{t(goals ? 'goal_library_intro' : 'competency_library_intro')}</p></div><div className="toolbar-actions"><button className="secondary-button" onClick={() => downloadWorkbook(exportRows, excelColumns, goals ? 'goal-library.xlsx' : 'competency-library.xlsx')}><Download /> {t('export_excel')}</button><button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload /> {t('import_excel')}</button><input hidden ref={fileRef} type="file" accept=".xlsx" onChange={async (event) => { const file = event.target.files?.[0]; if (file) await readImport(file); event.target.value = ''; }} /><button className="primary-button" onClick={() => setEditing({ is_active: true, version: 1, indicator_rows: [] })}><Plus /> {t(goals ? 'add_goal' : 'add_competency')}</button></div></div>{notice && <div className="inline-message"><Check />{notice}<button onClick={() => setNotice('')}><X /></button></div>}<div className="data-controls"><div className="search-control"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search_placeholder')} /></div><button className="filter-button"><Filter /> {t('all_categories')}</button><span className="result-count">{visible.length} {t('items')}</span></div><div className="data-table-wrap"><table className="enterprise-table library-table"><thead><tr><th>{t('code')}</th><th>{t(goals ? 'goal' : 'competency')}</th><th>{t(goals ? 'measurement_formula' : 'main_competency')}</th><th>{t('application_scope')}</th><th>{t(goals ? 'default_weight' : 'level_indicators')}</th><th>{t('active')}</th><th /></tr></thead><tbody>{visible.map((row) => <tr key={row.id || row.code}><td><code>{row.code}</code><small>{row.category}</small></td><td><b>{lang === 'ar' ? row.title : row.title_en || row.name_en || row.title}</b><small>{row.definition}</small></td><td><b>{goals ? row.measurement : row.parent}</b><small>{goals ? row.formula : `${row.indicators || 0} ${t('measurable_behaviors')}`}</small></td><td>{row.departments}<small>{row.jobs}</small></td><td>{goals ? `${row.default_weight || 0}%` : `${t('level')} ${row.level || 3}`}</td><td><button onClick={() => toggle(row)} className={`toggle ${row.active ? 'active' : ''}`}><span /></button></td><td><button className="icon-button" title={t('edit')} onClick={() => setEditing(row)}><Settings2 /></button></td></tr>)}</tbody></table></div>{editing && <LibraryModal kind={kind} item={editing} onClose={() => setEditing(null)} onSave={save} />}{importPreview && <div className="modal-backdrop" onClick={() => setImportPreview(null)}><div className="modal-card" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><h3>{t('import_preview')}</h3><small>{importPreview.fileName}</small></div><button className="icon-button" onClick={() => setImportPreview(null)}><X /></button></div><div className="import-stats"><span>{t('new_records')} <b>{importPreview.additions}</b></span><span>{t('updated_records')} <b>{importPreview.updates}</b></span><span>{t('errors')} <b>{importPreview.errors.length}</b></span></div>{importPreview.errors.length > 0 && <div className="import-errors">{importPreview.errors.map((error) => <p key={error}>{error}</p>)}</div>}<div className="modal-actions"><button className="secondary-button" onClick={() => setImportPreview(null)}>{t('cancelled')}</button><button className="primary-button" disabled={importPreview.errors.length > 0} onClick={commitImport}>{t('confirm_import')}</button></div></div></div>}</div>;
};

const OrganizationDirectory = ({ kind }) => {
  const { t, lang } = useLanguage();
  const positions = kind === 'positions';
  const [lookups, setLookups] = useState({ departments: [], positions: [] });
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = () => loadOrganizationLookups().then(setLookups).catch((error) => setNotice(error.message));
  useEffect(() => {
    let active = true;
    loadOrganizationLookups()
      .then((data) => { if (active) setLookups(data); })
      .catch((error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);
  const rows = lookups[kind].filter((row) => `${row.code} ${row.name_ar} ${row.name_en || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const save = async (draft) => {
    try {
      await saveOrganizationItem(kind, draft);
      await refresh();
      setEditing(null);
      setNotice(t('saved_successfully'));
    } catch (error) { setNotice(error.message); }
  };
  return <div className="admin-content"><div className="admin-toolbar"><div><span className="section-kicker">{t('organization_structure')}</span><h1>{t(positions ? 'positions' : 'departments')}</h1><p>{t(positions ? 'positions_intro' : 'departments_intro')}</p></div><button className="primary-button" onClick={() => setEditing({ is_active: true, display_order: 0 })}><Plus /> {t(positions ? 'add_position' : 'add_department')}</button></div>{notice && <div className="inline-message"><Check />{notice}</div>}<div className="data-controls"><div className="search-control"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search_placeholder')} /></div><span className="result-count">{rows.length} {t('items')}</span></div><div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th>{t('code')}</th><th>{t('name_arabic')}</th><th>{t('name_english')}</th>{positions && <th>{t('department')}</th>}<th>{t('display_order')}</th><th>{t('active')}</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><code>{row.code}</code></td><td><b>{row.name_ar}</b></td><td>{row.name_en}</td>{positions && <td>{lang === 'ar' ? row.departments?.name_ar : row.departments?.name_en || row.departments?.name_ar}</td>}<td>{row.display_order}</td><td><button className={`toggle ${row.is_active ? 'active' : ''}`} onClick={() => save({ ...row, is_active: !row.is_active })}><span /></button></td><td><button className="icon-button" onClick={() => setEditing(row)}><Pencil /></button></td></tr>)}</tbody></table></div>{editing && <div className="modal-backdrop" onClick={() => setEditing(null)}><form className="modal-card modal-wide" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); save(editing); }}><div className="modal-heading"><h3>{t(editing.id ? (positions ? 'edit_position' : 'edit_department') : (positions ? 'add_position' : 'add_department'))}</h3><button type="button" className="icon-button" onClick={() => setEditing(null)}><X /></button></div><div className="form-grid"><AdminInput required label={t('code')} value={editing.code} onChange={(value) => setEditing({ ...editing, code: value })} /><AdminInput required label={t('name_arabic')} value={editing.name_ar} onChange={(value) => setEditing({ ...editing, name_ar: value })} /><AdminInput label={t('name_english')} value={editing.name_en} onChange={(value) => setEditing({ ...editing, name_en: value })} /><AdminInput type="number" label={t('display_order')} value={editing.display_order} onChange={(value) => setEditing({ ...editing, display_order: value })} />{positions && <label className="field-label">{t('department')}<select className="form-input" value={editing.department_id || ''} onChange={(event) => setEditing({ ...editing, department_id: event.target.value || null })}><option value="">{t('not_assigned')}</option>{lookups.departments.filter((row) => row.is_active).map((row) => <option key={row.id} value={row.id}>{lang === 'ar' ? row.name_ar : row.name_en || row.name_ar}</option>)}</select></label>}<label className="field-label field-span-2">{t('description_arabic')}<textarea className="form-input" value={editing.description_ar || ''} onChange={(event) => setEditing({ ...editing, description_ar: event.target.value })} /></label><label className="field-label field-span-2">{t('description_english')}<textarea className="form-input" value={editing.description_en || ''} onChange={(event) => setEditing({ ...editing, description_en: event.target.value })} /></label></div><label className="content-publish-check"><input type="checkbox" checked={editing.is_active !== false} onChange={(event) => setEditing({ ...editing, is_active: event.target.checked })} /> {t('active')}</label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t('cancelled')}</button><button className="primary-button">{t('save')}</button></div></form></div>}</div>;
};

const proficiencySeed = [
  { id: '1', level_no: 1, code: 'LEVEL-1', name_ar: 'مبتدئ', name_en: 'Beginner', description_ar: 'يحتاج توجيهاً مباشراً ومتابعة مستمرة.', description_en: 'Requires direct guidance and regular follow-up.', is_active: true },
  { id: '2', level_no: 2, code: 'LEVEL-2', name_ar: 'أساسي', name_en: 'Basic', description_ar: 'يطبق الأساسيات في المواقف المعتادة.', description_en: 'Applies the fundamentals in routine situations.', is_active: true },
  { id: '3', level_no: 3, code: 'LEVEL-3', name_ar: 'متمكن', name_en: 'Proficient', description_ar: 'ينفذ باستقلالية وبجودة ثابتة.', description_en: 'Works independently with consistent quality.', is_active: true },
  { id: '4', level_no: 4, code: 'LEVEL-4', name_ar: 'متقدم', name_en: 'Advanced', description_ar: 'يتعامل مع الحالات المعقدة ويدعم الآخرين.', description_en: 'Handles complex cases and supports others.', is_active: true },
  { id: '5', level_no: 5, code: 'LEVEL-5', name_ar: 'خبير', name_en: 'Expert', description_ar: 'مرجع معرفي يطور الممارسة والمعايير.', description_en: 'A subject matter expert who advances standards.', is_active: true },
];

const ProficiencyModal = ({ item, onClose, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState({ is_active: true, ...item });
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  return <div className="modal-backdrop" onClick={onClose}><form className="modal-card modal-wide" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave(draft); }}><div className="modal-heading"><h3>{item.id ? t('edit_proficiency') : t('add_proficiency')}</h3><button type="button" className="icon-button" onClick={onClose}><X /></button></div><div className="form-grid"><label className="field-label">{t('level')}<input required type="number" min="1" max="5" className="form-input" value={draft.level_no || ''} onChange={field('level_no')} /></label><label className="field-label">{t('code')}<input required className="form-input" value={draft.code || ''} onChange={field('code')} /></label><label className="field-label">{t('name_arabic')}<input required className="form-input" value={draft.name_ar || ''} onChange={field('name_ar')} /></label><label className="field-label">{t('name_english')}<input required className="form-input" value={draft.name_en || ''} onChange={field('name_en')} /></label><label className="field-label field-span-2">{t('description_arabic')}<textarea className="form-input" value={draft.description_ar || ''} onChange={field('description_ar')} /></label><label className="field-label field-span-2">{t('description_english')}<textarea className="form-input" value={draft.description_en || ''} onChange={field('description_en')} /></label></div><label className="content-publish-check"><input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft({ ...draft, is_active: event.target.checked })} /> {t('active')}</label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancelled')}</button><button className="primary-button">{t('save')}</button></div></form></div>;
};

const Proficiency = () => {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState(proficiencySeed);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    try { setRows(await loadLibrary('proficiency', proficiencySeed)); } catch (error) { setNotice(error.message); }
  };
  useEffect(() => {
    let active = true;
    loadLibrary('proficiency', proficiencySeed)
      .then((data) => { if (active) setRows(data); })
      .catch((error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);
  const save = async (draft) => {
    const payload = { ...draft, id: draft.id && !['1','2','3','4','5'].includes(String(draft.id)) ? draft.id : undefined, level_no: Number(draft.level_no), display_order: Number(draft.level_no), version: Number(draft.version || 1) };
    try { await saveLibraryItem('proficiency', payload, rows); await refresh(); setEditing(null); setNotice(t('saved_successfully')); } catch (error) { setNotice(error.message); }
  };
  return <div className="admin-content"><div className="admin-toolbar"><div><span className="section-kicker">{t('evaluation_dictionary')}</span><h1>{t('proficiency_levels')}</h1><p>{t('proficiency_intro')}</p></div><button className="primary-button" onClick={() => setEditing({ is_active: true })}><Plus /> {t('add_proficiency')}</button></div>{notice && <div className="inline-message">{notice}</div>}<div className="proficiency-list">{rows.map((row) => <div key={row.id || row.level_no}><strong>{row.level_no}</strong><span><b>{lang === 'ar' ? row.name_ar : row.name_en || row.name_ar}</b><small>{lang === 'ar' ? row.description_ar : row.description_en || row.description_ar}</small></span><button className="icon-button" title={t('edit')} onClick={() => setEditing(row)}><Settings2 /></button></div>)}</div>{editing && <ProficiencyModal item={editing} onClose={() => setEditing(null)} onSave={save} />}</div>;
};

const emptyContent = {
  content_type: 'Document', code: '', title_ar: '', title_en: '', title_hi: '', title_ur: '', title_tl: '',
  external_url: '', file_type: 'pdf', publish_date: new Date().toISOString().slice(0, 10),
  version: '1.0', display_order: 0, priority: 'Normal', publication_level: 'PUBLIC', is_published: true,
};

const ContentManagement = () => {
  const { t, lang } = useLanguage();
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('All');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => setRows(await loadManagedContent());
  useEffect(() => {
    let active = true;
    loadManagedContent().then((items) => {
      if (active) setRows(items);
    });
    return () => { active = false; };
  }, []);
  const visible = rows.filter((row) => {
    const matchesType = type === 'All' || row.content_type === type;
    const haystack = `${row.code || ''} ${row.title_ar || ''} ${row.title_en || ''}`.toLowerCase();
    return matchesType && haystack.includes(query.toLowerCase());
  });
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveContentItem(draft);
      await refresh();
      window.dispatchEvent(new Event('shalfa-content-updated'));
      setDraft(null);
    } catch {
      setError(t('save_failed'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id) => {
    await deleteContentItem(id);
    await refresh();
    window.dispatchEvent(new Event('shalfa-content-updated'));
  };

  return <div className="admin-content">
    <div className="admin-toolbar"><div><span className="section-kicker">{t('content_management')}</span><h1>{t('content_library')}</h1><p>{t('content_management_intro')}</p></div><button className="primary-button" onClick={() => { setError(''); setDraft({ ...emptyContent }); }}><Plus /> {t('add_content')}</button></div>
    <div className="data-controls"><div className="search-control"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search_placeholder')} /></div><select className="filter-button" value={type} onChange={(event) => setType(event.target.value)}><option value="All">{t('all')}</option><option value="Document">{t('docs')}</option><option value="Circular">{t('circulars')}</option><option value="Design">{t('designs')}</option></select><span className="result-count">{visible.length}</span></div>
    <div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th>{t('code')}</th><th>{t('content_type')}</th><th>{t('name')}</th><th>{t('publication_level')}</th><th>{t('publish_date')}</th><th>{t('status')}</th><th /></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><code>{row.code}</code></td><td>{t(row.content_type === 'Document' ? 'docs' : row.content_type === 'Circular' ? 'circulars' : 'designs')}</td><td><b>{lang === 'ar' ? row.title_ar : row[`title_${lang}`] || row.title_en || row.title_ar}</b><small>{row.external_url}</small></td><td><span className="role-badge">{t(`publication_${String(row.publication_level || 'PUBLIC').toLowerCase()}`)}</span></td><td>{row.publish_date ? new Date(row.publish_date).toLocaleDateString() : '—'}</td><td><span className={`status-pill ${row.is_published ? 'status-approved' : 'status-draft'}`}>{row.is_published ? t('published') : t('draft')}</span></td><td><div className="table-actions"><a className="icon-button" href={row.external_url} target="_blank" rel="noreferrer"><ExternalLink /></a><button onClick={() => { setError(''); setDraft(row); }} title={t('edit')}><Pencil /></button><button className="danger" onClick={() => remove(row.id)} title={t('delete')}><Trash2 /></button></div></td></tr>)}</tbody></table></div>
    {draft && <div className="modal-backdrop" onClick={() => setDraft(null)}><form className="modal-card modal-wide" onSubmit={save} onClick={(event) => event.stopPropagation()}><div className="modal-heading"><h3>{draft.id ? t('edit') : t('add_content')}</h3><button type="button" className="icon-button" onClick={() => setDraft(null)}><X /></button></div><div className="form-grid">
      <label className="field-label">{t('content_type')}<select className="form-input" value={draft.content_type} onChange={(event) => setDraft({ ...draft, content_type: event.target.value })}><option value="Document">{t('docs')}</option><option value="Circular">{t('circulars')}</option><option value="Design">{t('designs')}</option></select></label>
      <label className="field-label">{t('publication_level')}<select className="form-input" value={draft.publication_level || 'PUBLIC'} onChange={(event) => setDraft({ ...draft, publication_level: event.target.value })}><option value="PUBLIC">{t('publication_public')}</option><option value="ADMINISTRATIVE">{t('publication_administrative')}</option><option value="MANAGER_RESTRICTED">{t('publication_manager_restricted')}</option><option value="PRIVATE_RESTRICTED">{t('publication_private_restricted')}</option></select></label>
      <AdminInput label={t('code')} value={draft.code} onChange={(value) => setDraft({ ...draft, code: value })} required />
      <AdminInput label={t('title_arabic')} value={draft.title_ar} onChange={(value) => setDraft({ ...draft, title_ar: value })} required />
      <AdminInput label={t('title_english')} value={draft.title_en} onChange={(value) => setDraft({ ...draft, title_en: value })} />
      <AdminInput label={t('external_link')} value={draft.external_url} onChange={(value) => setDraft({ ...draft, external_url: value })} required />
      <AdminInput label={t('publish_date')} type="date" value={draft.publish_date?.slice?.(0, 10)} onChange={(value) => setDraft({ ...draft, publish_date: value })} />
    </div>{error && <div className="modal-error"><X />{error}</div>}<label className="content-publish-check"><input type="checkbox" checked={draft.is_published} onChange={(event) => setDraft({ ...draft, is_published: event.target.checked })} /> {t('published')}</label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDraft(null)}>{t('cancelled')}</button><button className="primary-button" disabled={busy}>{busy ? t('saving') : t('save')}</button></div></form></div>}
  </div>;
};

const summarizeAudit = (row) => {
  const next = row.new_data || {};
  const previous = row.old_data || {};
  return next.reference_no || next.code || next.email || previous.reference_no || previous.code || previous.email || row.entity_id || '—';
};

const Audit = () => {
  const { t, locale } = useLanguage();
  const [rows, setRows] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (useLocalData) {
        setRows([]);
        setLoading(false);
        return;
      }
      const { data } = await supabase.from('audit_logs').select('*').order('created_on', { ascending: false }).limit(250);
      const logs = data || [];
      setRows(logs);
      const ids = [...new Set(logs.map((row) => row.actor_id).filter(Boolean))];
      if (ids.length) {
        const { data: users } = await supabase.from('users').select('id,full_name,full_name_ar,full_name_en,email').in('id', ids);
        setUsersById(Object.fromEntries((users || []).map((user) => [user.id, user])));
      }
      setLoading(false);
    };
    load();
  }, []);
  const visible = rows.filter((row) => `${row.action} ${row.entity_type} ${summarizeAudit(row)}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="admin-content"><div className="admin-toolbar"><div><span className="section-kicker">{t('governance')}</span><h1>{t('audit_log')}</h1><p>{t('audit_intro')}</p></div><button className="secondary-button" onClick={() => window.print()}><Download /> {t('download')}</button></div><div className="data-controls"><div className="search-control"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search_portal')} /></div><span className="result-count">{visible.length}</span></div><div className="data-table-wrap"><table className="enterprise-table"><thead><tr><th>{t('action')}</th><th>{t('user')}</th><th>{t('module')}</th><th>{t('details')}</th><th>{t('date_time')}</th></tr></thead><tbody>{visible.map((row) => { const actor = usersById[row.actor_id]; return <tr key={row.id}><td><span className="audit-action">{row.action}</span></td><td><b>{actor?.full_name || actor?.full_name_ar || actor?.email || 'System'}</b></td><td>{row.entity_type}</td><td><code>{summarizeAudit(row)}</code></td><td>{new Date(row.created_on).toLocaleString(locale)}</td></tr>; })}{!loading && !visible.length && <tr><td colSpan="5"><div className="empty-table"><History /><b>{t('no_audit_records')}</b></div></td></tr>}{loading && <tr><td colSpan="5">{t('loading')}</td></tr>}</tbody></table></div></div>;
};

const AdminCenter = () => {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const [section, setSection] = useState('employees');
  const platformAdmin = profile?.role_code === 'PLATFORM_ADMIN';
  const systemAdmin = profile?.role_code === 'SYSTEM_ADMIN';
  const allowed = platformAdmin || systemAdmin;
  const visibleNavItems = platformAdmin
    ? navItems
    : navItems.filter((item) => ['employees', 'analytics', 'approval_tracking'].includes(item.id));
  const content = useMemo(() => ({
    analytics: <Analytics />, employees: <Employees />, departments: <OrganizationDirectory kind="departments" />, positions: <OrganizationDirectory kind="positions" />, content: <ContentManagement />, cycles: <Cycles />, goals: <LibraryTable kind="goals" />,
    competencies: <LibraryTable kind="competencies" />, proficiency: <Proficiency />, audit: <Audit />,
    approval_setup: <ApprovalSetupAdmin />, approval_tracking: <ApprovalTrackingAdmin />,
  }), []);
  if (!allowed) return <main className="app-main empty-state"><ShieldCheck /><h1>{t('permission_denied')}</h1></main>;
  const activeSection = visibleNavItems.some((item) => item.id === section) ? section : visibleNavItems[0].id;
  return <main className="admin-page"><aside className="admin-sidebar"><div><span>{t('management_system')}</span><strong>ShalfaGate Control</strong></div><nav>{visibleNavItems.map(({ id, labelKey, icon: Icon }) => <button key={id} className={activeSection === id ? 'active' : ''} onClick={() => setSection(id)}><Icon />{t(labelKey)}</button>)}</nav><div className="admin-version"><UserCog /><div><b>{t('administrator_mode')}</b><small>{t('enterprise_edition')}</small></div></div></aside>{content[activeSection]}</main>;
};

export default AdminCenter;
