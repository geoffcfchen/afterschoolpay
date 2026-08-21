import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore/lite";
import { updateProfile } from "firebase/auth";
import { firestore } from "./firebase";

export const DEFAULT_ORG_ID = "afterschoolpay";
export const DEFAULT_ORG_NAME = "互動霧峰加盟校";

export const DEFAULT_BRANCHES = [
  {
    id: "school-1",
    name: "一校",
    shortName: "一",
    status: "active",
    sortOrder: 1,
  },
  {
    id: "school-2",
    name: "二校",
    shortName: "二",
    status: "active",
    sortOrder: 2,
  },
  {
    id: "school-3",
    name: "三校",
    shortName: "三",
    status: "active",
    sortOrder: 3,
  },
];

const DEFAULT_PROGRAMS = [
  {
    id: "elementary-core",
    name: "國小課後班",
    subjects: ["安親", "英文", "數學", "美術", "圍棋"],
    status: "active",
    sortOrder: 1,
  },
  {
    id: "middle-school-core",
    name: "國中課後班",
    subjects: ["英文", "數學", "理化"],
    status: "active",
    sortOrder: 2,
  },
];

export const PERMISSION_DEFINITIONS = [
  {
    key: "canManageOrganization",
    label: "管理組織",
    description: "修改組織設定與基礎資料。",
  },
  {
    key: "canManageMembers",
    label: "團隊權限",
    description: "開通帳號、調整角色與可查看分校。",
  },
  {
    key: "canRecordDailyLedger",
    label: "每日收支",
    description: "記錄與查看日常付款、退款與雜支。",
  },
  {
    key: "canViewAllBranches",
    label: "查看全部分校",
    description: "不受單一分校限制。",
  },
  {
    key: "canViewPayroll",
    label: "老師薪資",
    description: "查看老師薪資與發放紀錄。",
  },
  {
    key: "canViewStudents",
    label: "學生與課程",
    description: "管理學生、課程與繳費通知單。",
  },
];

export const OWNER_PERMISSIONS = {
  canManageOrganization: true,
  canManageMembers: true,
  canRecordDailyLedger: true,
  canViewAllBranches: true,
  canViewPayroll: true,
  canViewStudents: true,
};

export const PENDING_PERMISSIONS = {
  canManageOrganization: false,
  canManageMembers: false,
  canRecordDailyLedger: false,
  canViewAllBranches: false,
  canViewPayroll: false,
  canViewStudents: false,
};

export const ROLE_LEVELS = {
  1: "等級 1：負責人",
  2: "等級 2：分校主管",
  3: "等級 3：行政人員",
  4: "等級 4：等待開通",
};

const ROLE_LABELS = ROLE_LEVELS;

export const ROLE_PRESETS = {
  1: {
    role: "owner",
    status: "active",
    permissions: OWNER_PERMISSIONS,
  },
  2: {
    role: "branch-manager",
    status: "active",
    permissions: {
      ...PENDING_PERMISSIONS,
      canRecordDailyLedger: true,
      canViewPayroll: true,
      canViewStudents: true,
    },
  },
  3: {
    role: "staff",
    status: "active",
    permissions: {
      ...PENDING_PERMISSIONS,
      canRecordDailyLedger: true,
      canViewStudents: true,
    },
  },
  4: {
    role: "pending",
    status: "pending",
    permissions: PENDING_PERMISSIONS,
  },
};

const normalizeEmail = (email) => (email || "").trim().toLowerCase();

const ORGANIZATION_SETUP_REQUIRED_MESSAGES = new Set([
  "尚未選擇組織。",
  "組織尚未建立。",
]);

const DISPLAY_NAME_SETUP_REQUIRED_MESSAGE = "尚未設定姓名。";

export function isOrganizationSetupRequiredError(error) {
  return ORGANIZATION_SETUP_REQUIRED_MESSAGES.has(error?.message);
}

export function isDisplayNameSetupRequiredError(error) {
  return error?.message === DISPLAY_NAME_SETUP_REQUIRED_MESSAGE;
}

function getDefaultBranchesForOrganization(orgId) {
  if (orgId === DEFAULT_ORG_ID) {
    return DEFAULT_BRANCHES;
  }

  return [];
}

const requireFirestore = () => {
  if (!firestore) {
    throw new Error(
      "Firebase 尚未設定完成。請先加入 VITE_FB_* 設定值，再載入管理後台。",
    );
  }

  return firestore;
};

const sortByOrder = (items) =>
  [...items].sort((first, second) => {
    const firstOrder = first.sortOrder ?? 0;
    const secondOrder = second.sortOrder ?? 0;

    if (firstOrder !== secondOrder) {
      return firstOrder - secondOrder;
    }

    const firstLabel = first.name || first.displayName || first.email || first.id;
    const secondLabel =
      second.name || second.displayName || second.email || second.id;

    return firstLabel.localeCompare(secondLabel);
  });

const normalizeDisplayName = (displayName) =>
  (displayName || "").trim().replace(/\s+/g, " ");

async function setIfMissing(ref, data) {
  const snapshot = await getDoc(ref);

  if (snapshot.exists()) {
    return {
      id: ref.id,
      ...snapshot.data(),
    };
  }

  const createData = {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(ref, createData);

  return {
    id: ref.id,
    ...data,
  };
}

async function listSubcollection(path) {
  const db = requireFirestore();
  const snapshot = await getDocs(collection(db, ...path));
  const records = snapshot.docs.map((record) => ({
    id: record.id,
    ...record.data(),
  }));

  return sortByOrder(records);
}

export async function listOrganizations() {
  const db = requireFirestore();
  const snapshot = await getDocs(
    query(collection(db, "organizations"), orderBy("name"), limit(50)),
  );
  const records = snapshot.docs.map((record) => ({
    id: record.id,
    ...record.data(),
  }));

  return records.filter((organization) => organization.status === "active");
}

export function getRoleLevelLabel(level) {
  return ROLE_LABELS[level] || "自訂權限";
}

export function getRolePreset(level) {
  return ROLE_PRESETS[level] || ROLE_PRESETS[4];
}

export function getRolePresetPermissions(level) {
  return {
    ...PENDING_PERMISSIONS,
    ...(getRolePreset(level).permissions || {}),
  };
}

function canSeedOrganization(member) {
  return member.roleLevel === 1 || member.permissions?.canManageOrganization;
}

export async function ensureUserProfile(user, options = {}) {
  const db = requireFirestore();
  const requireDisplayName = options.requireDisplayName === true;
  const profileRef = doc(db, "users", user.uid);
  const profileSnapshot = await getDoc(profileRef);
  const existingProfile = profileSnapshot.exists() ? profileSnapshot.data() : {};
  const savedDisplayName = normalizeDisplayName(existingProfile.displayName);
  const existingOrgIds = Array.isArray(existingProfile.orgIds)
    ? existingProfile.orgIds
    : existingProfile.orgIds
      ? [existingProfile.orgIds]
      : [];
  const orgIds = new Set(existingOrgIds.filter(Boolean));
  const orgIdList = Array.from(orgIds);
  const activeOrgId =
    (typeof existingProfile.activeOrgId === "string"
      ? existingProfile.activeOrgId
      : "") ||
    orgIdList[0] ||
    "";

  const baseProfile = {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: savedDisplayName,
    photoURL: user.photoURL || "",
    activeOrgId,
    orgIds: orgIdList,
    lastLoginAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (!profileSnapshot.exists()) {
    await setDoc(profileRef, {
      ...baseProfile,
      createdAt: serverTimestamp(),
    });

    const createdProfile = {
      ...baseProfile,
      createdAt: null,
      lastLoginAt: null,
      updatedAt: null,
    };

    if (requireDisplayName && !createdProfile.displayName) {
      throw new Error(DISPLAY_NAME_SETUP_REQUIRED_MESSAGE);
    }

    return createdProfile;
  }

  await setDoc(profileRef, baseProfile, { merge: true });

  const profile = {
    ...existingProfile,
    ...baseProfile,
    lastLoginAt: existingProfile.lastLoginAt || null,
    updatedAt: existingProfile.updatedAt || null,
  };

  if (requireDisplayName && !profile.displayName) {
    throw new Error(DISPLAY_NAME_SETUP_REQUIRED_MESSAGE);
  }

  return profile;
}

export async function saveUserDisplayName(user, displayName) {
  const db = requireFirestore();
  const trimmedName = normalizeDisplayName(displayName);

  if (!trimmedName) {
    throw new Error("請輸入姓名。");
  }

  const profile = await ensureUserProfile(user);

  if (user && user.displayName !== trimmedName) {
    await updateProfile(user, {
      displayName: trimmedName,
    });
  }

  const profileData = {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: trimmedName,
    photoURL: user.photoURL || "",
    updatedAt: serverTimestamp(),
  };

  await setDoc(doc(db, "users", user.uid), profileData, { merge: true });

  await Promise.all(
    (profile.orgIds || []).map(async (orgId) => {
      const memberRef = doc(db, "organizations", orgId, "members", user.uid);
      const memberSnapshot = await getDoc(memberRef);

      if (!memberSnapshot.exists()) {
        return;
      }

      await setDoc(
        memberRef,
        {
          displayName: trimmedName,
          email: profileData.email,
          photoURL: profileData.photoURL,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }),
  );

  return {
    ...profile,
    ...profileData,
  };
}

export async function ensureDefaultOrganization(member, orgId = DEFAULT_ORG_ID) {
  const db = requireFirestore();
  const organizationRef = doc(db, "organizations", orgId);
  const organizationSnapshot = await getDoc(organizationRef);
  const seedAllowed = canSeedOrganization(member);
  const defaultBranches = getDefaultBranchesForOrganization(orgId);
  let organization;

  if (organizationSnapshot.exists()) {
    organization = {
      id: organizationRef.id,
      ...organizationSnapshot.data(),
    };

    if (
      seedAllowed &&
      orgId === DEFAULT_ORG_ID &&
      organization.name !== DEFAULT_ORG_NAME
    ) {
      await setDoc(
        organizationRef,
        {
          name: DEFAULT_ORG_NAME,
          slug: DEFAULT_ORG_ID,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      organization = {
        ...organization,
        name: DEFAULT_ORG_NAME,
        slug: DEFAULT_ORG_ID,
      };
    }
  } else {
    if (!seedAllowed) {
      throw new Error("組織尚未建立。");
    }

    const organizationData = {
      name: orgId === DEFAULT_ORG_ID ? DEFAULT_ORG_NAME : "新組織",
      slug: orgId,
      status: "active",
      timezone: "Asia/Taipei",
      plan: "prototype",
    };

    await setDoc(organizationRef, {
      ...organizationData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    organization = {
      id: organizationRef.id,
      ...organizationData,
    };
  }

  if (!seedAllowed) {
    return organization;
  }

  await Promise.all(
    defaultBranches.map((branch) =>
      setIfMissing(
        doc(db, "organizations", orgId, "branches", branch.id),
        branch,
      ),
    ),
  );

  await Promise.all(
    DEFAULT_PROGRAMS.map((program) =>
      setIfMissing(
        doc(db, "organizations", orgId, "programs", program.id),
        program,
      ),
    ),
  );

  return organization;
}

function getProfileDisplayName(user, profile) {
  return normalizeDisplayName(profile?.displayName) || user.displayName || "";
}

function buildOwnerMember(user, orgId = DEFAULT_ORG_ID, profile = null) {
  const branchIds = getDefaultBranchesForOrganization(orgId).map(
    (branch) => branch.id,
  );

  return {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: getProfileDisplayName(user, profile),
    photoURL: user.photoURL || "",
    role: "owner",
    roleLevel: 1,
    status: "active",
    branchIds,
    permissions: OWNER_PERMISSIONS,
    invitedBy: "bootstrap-owner",
    updatedAt: serverTimestamp(),
  };
}

function buildPendingMember(user, profile = null) {
  return {
    uid: user.uid,
    email: normalizeEmail(user.email),
    displayName: getProfileDisplayName(user, profile),
    photoURL: user.photoURL || "",
    role: "pending",
    roleLevel: 4,
    status: "pending",
    branchIds: [],
    permissions: PENDING_PERMISSIONS,
    invitedBy: "self-signup",
    updatedAt: serverTimestamp(),
  };
}

export async function ensureOrganizationMember(
  user,
  orgId = DEFAULT_ORG_ID,
  profile = null,
) {
  const db = requireFirestore();
  const memberRef = doc(
    db,
    "organizations",
    orgId,
    "members",
    user.uid,
  );
  const memberSnapshot = await getDoc(memberRef);
  const displayName = getProfileDisplayName(user, profile);
  const email = normalizeEmail(user.email);
  const photoURL = user.photoURL || "";

  if (memberSnapshot.exists()) {
    const existingMember = {
      id: memberRef.id,
      ...memberSnapshot.data(),
    };

    if (
      displayName &&
      (existingMember.displayName !== displayName ||
        existingMember.email !== email ||
        existingMember.photoURL !== photoURL)
    ) {
      await setDoc(
        memberRef,
        {
          displayName,
          email,
          photoURL,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      return {
        ...existingMember,
        displayName,
        email,
        photoURL,
      };
    }

    return {
      ...existingMember,
    };
  }

  const member = buildPendingMember(user, profile);

  await setDoc(memberRef, {
    ...member,
    createdAt: serverTimestamp(),
  });

  return {
    id: memberRef.id,
    ...member,
    createdAt: null,
    updatedAt: null,
  };
}

export async function loadOrganizationWorkspace(user) {
  const profile = await ensureUserProfile(user, { requireDisplayName: true });
  const activeOrgId = profile.activeOrgId || profile.orgIds?.[0] || "";

  if (!activeOrgId) {
    throw new Error("尚未選擇組織。");
  }

  const member = await ensureOrganizationMember(user, activeOrgId, profile);
  const organization = await ensureDefaultOrganization(member, activeOrgId);
  const [branches, programs] = await Promise.all([
    listSubcollection(["organizations", activeOrgId, "branches"]),
    listSubcollection(["organizations", activeOrgId, "programs"]),
  ]);
  const allowedBranchIds = new Set(member.branchIds || []);
  const canViewAllBranches =
    member.permissions?.canViewAllBranches || member.roleLevel === 1;
  const visibleBranches = canViewAllBranches
    ? branches
    : branches.filter((branch) => allowedBranchIds.has(branch.id));

  return {
    profile,
    organization,
    activeOrgId,
    member,
    branches,
    visibleBranches,
    programs,
  };
}

function buildOrganizationId(name) {
  const slug = normalizeEmail(name)
    .replace(/@/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug || "organization"}-${Date.now().toString(36)}`;
}

function buildBranchId() {
  return `branch-${Date.now().toString(36)}`;
}

async function saveProfileOrganization(profile, orgId) {
  const db = requireFirestore();
  const orgIds = new Set(profile.orgIds || []);
  orgIds.add(orgId);

  await setDoc(
    doc(db, "users", profile.uid),
    {
      activeOrgId: orgId,
      orgIds: Array.from(orgIds),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function createOrganizationBranch({
  createdByUid = "",
  name,
  orgId = DEFAULT_ORG_ID,
}) {
  const db = requireFirestore();
  const branchName = name.trim();

  if (!branchName) {
    throw new Error("請輸入分校名稱。");
  }

  const branches = await listSubcollection([
    "organizations",
    orgId,
    "branches",
  ]);
  const sortOrder =
    branches.reduce(
      (largest, branch) => Math.max(largest, Number(branch.sortOrder) || 0),
      0,
    ) + 1;
  const branchId = buildBranchId();
  const branch = {
    name: branchName,
    shortName: branchName.replace(/校$/, "") || branchName,
    status: "active",
    sortOrder,
    createdByUid,
  };

  await setDoc(doc(db, "organizations", orgId, "branches", branchId), {
    ...branch,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    id: branchId,
    ...branch,
    createdAt: null,
    updatedAt: null,
  };
}

export async function requestOrganizationAccess(
  user,
  orgId = DEFAULT_ORG_ID,
) {
  const db = requireFirestore();
  const profile = await ensureUserProfile(user, { requireDisplayName: true });
  const memberRef = doc(db, "organizations", orgId, "members", user.uid);
  const memberSnapshot = await getDoc(memberRef);

  if (!memberSnapshot.exists()) {
    const member = buildPendingMember(user, profile);

    await setDoc(memberRef, {
      ...member,
      invitedBy: "organization-request",
      createdAt: serverTimestamp(),
    });
  }

  await saveProfileOrganization(profile, orgId);

  return {
    orgId,
  };
}

export async function createOrganizationForUser(user, organizationName) {
  const db = requireFirestore();
  const name = organizationName.trim();
  const orgId = buildOrganizationId(name);
  const profile = await ensureUserProfile(user, { requireDisplayName: true });
  const organizationRef = doc(db, "organizations", orgId);
  const branchRecords = getDefaultBranchesForOrganization(orgId);

  await setDoc(organizationRef, {
    name,
    slug: orgId,
    status: "active",
    timezone: "Asia/Taipei",
    plan: "prototype",
    createdByUid: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await setDoc(doc(db, "organizations", orgId, "members", user.uid), {
    ...buildOwnerMember(user, orgId, profile),
    invitedBy: "organization-creator",
    createdAt: serverTimestamp(),
  });

  await Promise.all([
    ...branchRecords.map((branch) =>
      setDoc(doc(db, "organizations", orgId, "branches", branch.id), {
        ...branch,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    ),
    ...DEFAULT_PROGRAMS.map((program) =>
      setDoc(doc(db, "organizations", orgId, "programs", program.id), {
        ...program,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    ),
  ]);

  await saveProfileOrganization(profile, orgId);

  return {
    orgId,
    name,
  };
}

export async function loadOrganizationMembers(orgId = DEFAULT_ORG_ID) {
  const records = await listSubcollection(["organizations", orgId, "members"]);

  return records.sort((first, second) => {
    const firstLevel = first.roleLevel ?? 4;
    const secondLevel = second.roleLevel ?? 4;

    if (firstLevel !== secondLevel) {
      return firstLevel - secondLevel;
    }

    if (first.status !== second.status) {
      return first.status === "active" ? -1 : 1;
    }

    return (first.email || "").localeCompare(second.email || "");
  });
}

export async function updateOrganizationMember(
  memberId,
  changes,
  updatedByUid,
  orgId = DEFAULT_ORG_ID,
) {
  const db = requireFirestore();
  const roleLevel = Number(changes.roleLevel) || 4;
  const preset = getRolePreset(roleLevel);
  const permissions =
    roleLevel === 1
      ? OWNER_PERMISSIONS
      : roleLevel === 4
        ? PENDING_PERMISSIONS
        : {
            ...PENDING_PERMISSIONS,
            ...(changes.permissions || preset.permissions),
          };
  const branchIds =
    roleLevel === 1
      ? getDefaultBranchesForOrganization(orgId).map((branch) => branch.id)
      : [...new Set(changes.branchIds || [])];
  const status =
    roleLevel === 1 || roleLevel === 2 || roleLevel === 3
      ? changes.status === "suspended"
        ? "suspended"
        : "active"
      : "pending";
  const memberRef = doc(
    db,
    "organizations",
    orgId,
    "members",
    memberId,
  );

  await setDoc(
    memberRef,
    {
      role: preset.role,
      roleLevel,
      status,
      branchIds,
      permissions,
      updatedByUid: updatedByUid || "",
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
