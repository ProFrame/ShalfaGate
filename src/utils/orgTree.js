/**
 * Transforms a flat array of organizational items into a tree structure.
 */
export const buildOrgTree = (items) => {
  const itemMap = {};
  items.forEach(item => {
    itemMap[item.id] = { ...item, children: [] };
  });

  const tree = [];
  items.forEach(item => {
    const node = itemMap[item.id];
    if (item.parentId && itemMap[item.parentId]) {
      itemMap[item.parentId].children.push(node);
      itemMap[item.parentId].children.sort((a, b) => (a.sortOrder || 999) - (b.sortOrder || 999));
    } else {
      tree.push(node);
    }
  });

  return tree;
};

export const getChildren = (items, parentId) => {
  return items.filter(item => item.parentId === parentId).sort((a, b) => (a.sortOrder || 999) - (b.sortOrder || 999));
};

export const findOrgItem = (items, id) => {
  return items.find(item => item.id === id);
};

export const getParentItem = (items, item) => {
  if (!item || !item.parentId) return null;
  return items.find(i => i.id === item.parentId);
};

export const getBreadcrumb = (items, itemId) => {
  const breadcrumb = [];
  let current = findOrgItem(items, itemId);
  while (current) {
    breadcrumb.unshift(current);
    current = getParentItem(items, current);
  }
  return breadcrumb;
};

export const validateOrgItems = (items) => {
  const errors = [];
  const ids = new Set();

  items.forEach(item => {
    if (!item.id) errors.push(`Missing ID for item: ${JSON.stringify(item)}`);
    if (ids.has(item.id)) errors.push(`Duplicate ID found: ${item.id}`);
    ids.add(item.id);

    if (item.parentId && !items.find(i => i.id === item.parentId)) {
      errors.push(`Parent ID ${item.parentId} not found for item ${item.id}`);
    }
  });

  // Check for cycles
  items.forEach(item => {
    let current = item;
    const visited = new Set();
    while (current && current.parentId) {
      if (visited.has(current.id)) {
        errors.push(`Circular reference detected involving: ${current.id}`);
        break;
      }
      visited.add(current.id);
      current = getParentItem(items, current);
    }
  });

  return { isValid: errors.length === 0, errors };
};

export const wouldCreateCycle = (items, itemId, newParentId) => {
  if (!newParentId) return false;
  if (itemId === newParentId) return true;

  let currentParentId = newParentId;
  while (currentParentId) {
    if (currentParentId === itemId) return true;
    const parent = findOrgItem(items, currentParentId);
    currentParentId = parent ? parent.parentId : null;
  }
  return false;
};

export const deleteBranch = (items, itemId) => {
  const idsToRemove = new Set();
  const collectIds = (id) => {
    idsToRemove.add(id);
    items.filter(item => item.parentId === id).forEach(child => collectIds(child.id));
  };
  collectIds(itemId);
  return items.filter(item => !idsToRemove.has(item.id));
};

export const hasChildren = (items, itemId) => {
  return items.some(item => item.parentId === itemId);
};

export const normalizeOrgItem = (item) => {
  return {
    id: item.id || '',
    parentId: item.parentId || null,
    positionAr: item.positionAr || '',
    positionEn: item.positionEn || '',
    employeeNameAr: item.employeeNameAr || '',
    employeeNameEn: item.employeeNameEn || '',
    phone: item.phone || '',
    email: item.email || '',
    avatarUrl: item.avatarUrl || '',
    status: item.status || (item.employeeNameAr ? 'occupied' : 'vacant'),
    departmentCode: item.departmentCode || '',
    location: item.location || '',
    notesAr: item.notesAr || '',
    notesEn: item.notesEn || '',
    sortOrder: parseInt(item.sortOrder) || 999
  };
};
