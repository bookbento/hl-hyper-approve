import React, { useCallback, useEffect, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import Modal from "react-modal";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import SignatureCanvas from "react-signature-canvas";
import { api } from "../../lib/api";
import { IoColorPaletteSharp } from "react-icons/io5";
import { FaPaintbrush } from "react-icons/fa6";
import { toSecureUploadUrl, getAvatarUrlFromUser } from "../../lib/files";

interface User {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  email: string;
  role: string;
  department: { name: string } | null;
  businessUnit: { name: string } | null;
  profileImageUrl?: string | null;
  defaultSignatureText?: string | null;
}

Modal.setAppElement("#root");

const getCroppedImg = (imageSrc: string, crop: any): Promise<string> => {
  return new Promise((resolve) => {
    const image = new Image();
    image.src = imageSrc;
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height
      );

      resolve(canvas.toDataURL("image/jpeg"));
    };
  });
};

const ProfilePage: React.FC = () => {
  const { t } = useTranslation("profile");
  const [user, setUser] = useState<User | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "password" | "signature" | "delegation" | "notifications" | "sessions">("profile");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
  const [croppedPreview, setCroppedPreview] = useState<string | null>(null);
  const [showCropModal, setShowCropModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [penColor, setPenColor] = useState("#000000");
  type SigFile = { id: number; path: string; label: string | null };
  const sigPadRef = useRef<SignatureCanvas>(null);
  const [signatures, setSignatures] = useState<SigFile[]>([]);
  const [defaultSigId, setDefaultSigId] = useState<number | null>(null);
  const [sigFile, setSigFile] = useState<File | null>(null);
  const [sigPreviewUrl, setSigPreviewUrl] = useState<string | null>(null);
  const clearDraw = () => sigPadRef.current?.clear();
  const [penWidth, setPenWidth] = useState(3);
  const [imgFailed, setImgFailed] = useState(false);

  // Password strength calculation
  const calculatePasswordStrength = (password: string): PasswordStrength => {
    if (password.length < 6) {
      return {
        level: 'weak',
        label: t('passwordStrengthWeak') || 'Weak',
        color: 'text-red-600',
        bgColor: 'bg-red-100'
      };
    }

    const hasLetters = /[a-zA-Z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChars = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (password.length >= 8 && hasLetters && hasNumbers && hasSpecialChars) {
      return {
        level: 'strong',
        label: t('passwordStrengthStrong') || 'Strong',
        color: 'text-green-600',
        bgColor: 'bg-green-100'
      };
    }

    if (password.length >= 6 && hasLetters && hasNumbers) {
      return {
        level: 'medium',
        label: t('passwordStrengthMedium') || 'Medium',
        color: 'text-yellow-600',
        bgColor: 'bg-yellow-100'
      };
    }

    return {
      level: 'weak',
      label: t('passwordStrengthWeak') || 'Weak',
      color: 'text-red-600',
      bgColor: 'bg-red-100'
    };
  };

  // Delegation state
  const [delegatedToUserId, setDelegatedToUserId] = useState<number | null>(null);
  const [delegatedToUserName, setDelegatedToUserName] = useState<string>("");
  const [delegationStartDate, setDelegationStartDate] = useState<string>("");
  const [delegationEndDate, setDelegationEndDate] = useState<string>("");
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [delegationLoading, setDelegationLoading] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState("");

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordChanging, setPasswordChanging] = useState(false);

  interface PasswordStrength {
    level: 'weak' | 'medium' | 'strong';
    label: string;
    color: string;
    bgColor: string;
  }
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  // Notification preferences state
  interface NotificationPreference {
    notificationTypeId: number;
    notificationTypeName: string;
    notificationTypeSlug: string;
    notificationTypeDescription: string | null;
    emailEnabled: boolean;
  }
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreference[]>([]);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [activeNotifCategory, setActiveNotifCategory] = useState<"Approval" | "DocumentStatus" | "Comment">("Approval");

  // Default signature text state
  const [defaultSignatureText, setDefaultSignatureText] = useState<string>("");
  const [defaultSigTextSaving, setDefaultSigTextSaving] = useState(false);

  // Login session state
  interface LoginSession {
    id: number;
    loginAt: string;
    logoutAt: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  }
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionFilterIp, setSessionFilterIp] = useState("");
  const [sessionFilterDevice, setSessionFilterDevice] = useState("");
  const [sessionFilterStatus, setSessionFilterStatus] = useState<"all" | "active" | "closed">("all");
  const [sessionFilterFrom, setSessionFilterFrom] = useState("");
  const [sessionFilterTo, setSessionFilterTo] = useState("");

  const saveDefaultSignatureText = async () => {
    if (!user) return;
    setDefaultSigTextSaving(true);
    try {
      await api.put(`/api/users/${user.id}`, { defaultSignatureText }, { withCredentials: true });
      toast.success(t("defaultSignatureTextSaved") || "Default signature text saved!");
    } catch (err: any) {
      toast.error(err.response?.data?.error || t("defaultSignatureTextError") || "Failed to save");
    } finally {
      setDefaultSigTextSaving(false);
    }
  };

  const saveDrawn = () => {
    const pad = sigPadRef.current;
    if (!pad || pad.isEmpty()) {
      toast.error("Please draw your signature before saving");
      return;
    }
    const canvas = pad.getCanvas();
    canvas.style.background = "transparent";

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "signature.png");

      try {
        await api.post(`/api/users/${user!.id}/signatures`, fd);
        toast.success("Signature saved and uploaded successfully");
        clearDraw();
        loadSignatures(user!.id);
      } catch (err: any) {
        toast.error(err.response?.data?.error || "Upload failed");
      }
    }, "image/png");
  };

  const loadSignatures = async (uid: number) => {
    const { data } = await api.get(`/api/users/${uid}/signatures`, {
      withCredentials: true,
    });
    const { defaultSignatureId, signatures } = data;
    setSignatures(signatures ?? []);
    setDefaultSigId(defaultSignatureId ?? null);
  };

  const containerRef = useRef<HTMLDivElement>(null);

  const resizeCanvas = useCallback(() => {
    const pad = sigPadRef.current;
    const container = containerRef.current;
    if (!pad || !container) return;

    const canvas = pad.getCanvas();
    const ctx = canvas.getContext("2d")!;
    const ratio = window.devicePixelRatio || 1;
    const w = container.offsetWidth;
    const h = container.offsetHeight;

    canvas.width = w * ratio;
    canvas.height = h * ratio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    ctx.scale(ratio, ratio);
    pad.clear();
  }, []);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [resizeCanvas]);

  useEffect(() => {
    if (activeTab === "signature" && user) {
      loadSignatures(user.id);
      // Load default signature text from user
      setDefaultSignatureText(user.defaultSignatureText || "");
    }
    if (activeTab === "delegation" && user) loadDelegationData(user.id);
    if (activeTab === "notifications" && user) loadNotificationPreferences();
    if (activeTab === "sessions") loadSessions();
  }, [activeTab, user]);

  useEffect(() => {
    setImgFailed(false);
  }, [user?.profileImageUrl]);

  // Update password strength when newPassword changes
  useEffect(() => {
    if (newPassword) {
      setPasswordStrength(calculatePasswordStrength(newPassword));
    } else {
      setPasswordStrength(null);
    }
  }, [newPassword]);

  // Check password mismatch when confirmPassword changes
  useEffect(() => {
    if (confirmPassword && newPassword) {
      setPasswordMismatch(newPassword !== confirmPassword);
    } else {
      setPasswordMismatch(false);
    }
  }, [newPassword, confirmPassword]);

  const deleteSig = async (sigId: number) => {
    await api.delete(`/api/users/signatures/${sigId}`, { withCredentials: true });
    if (sigId === defaultSigId) await setDefault(user!.id, null);
    await loadSignatures(user!.id);
  };

  const setDefault = async (uid: number, sigId: number | null) => {
    await api.put(`/api/users/${uid}/default-signature`, { signatureId: sigId }, { withCredentials: true });
    setDefaultSigId(sigId);
  };

  // Delegation functions
  const loadDelegationData = async (uid: number) => {
    try {
      const { data } = await api.get(`/api/users/${uid}/delegation`, { withCredentials: true });
      setDelegatedToUserId(data.delegatedToUser?.id || null);
      setDelegatedToUserName(data.delegatedToUser ? 
        `${data.delegatedToUser.name} ${data.delegatedToUser.lastname || ''}`.trim() : "");
      setDelegationStartDate(data.delegationStartDate ? new Date(data.delegationStartDate).toISOString().slice(0, 16) : "");
      setDelegationEndDate(data.delegationEndDate ? new Date(data.delegationEndDate).toISOString().slice(0, 16) : "");
    } catch (err) {
      console.error("Failed to load delegation data:", err);
    }
  };

  const loadAvailableUsers = async (query: string = "") => {
    try {
      const { data } = await api.get("/api/users/search", {
        params: { q: query, exclude: user?.id },
        withCredentials: true,
      });
      setAvailableUsers(data);
    } catch (err) {
      console.error("Failed to load users:", err);
    }
  };

  const saveDelegation = async () => {
    if (!user) return;
    
    setDelegationLoading(true);
    try {
      await api.put(`/api/users/${user.id}/delegation`, {
        delegatedToUserId,
        delegationStartDate: delegationStartDate || null,
        delegationEndDate: delegationEndDate || null,
      }, { withCredentials: true });
      
      // Reload delegation data to ensure the badge shows correctly
      await loadDelegationData(user.id);
      
      toast.success(t("delegationSavedSuccess") || "Delegation settings saved successfully");
    } catch (err: any) {
      toast.error(err.response?.data?.error || t("delegationSavedFail") || "Failed to save delegation settings");
    } finally {
      setDelegationLoading(false);
    }
  };

  const clearDelegation = async () => {
    if (!user) return;
    
    setDelegationLoading(true);
    try {
      await api.delete(`/api/users/${user.id}/delegation`, { withCredentials: true });
      setDelegatedToUserId(null);
      setDelegatedToUserName("");
      setDelegationStartDate("");
      setDelegationEndDate("");
      toast.success(t("delegationClearedSuccess") || "Delegation cleared successfully");
    } catch (err: any) {
      toast.error(err.response?.data?.error || t("delegationClearedFail") || "Failed to clear delegation");
    } finally {
      setDelegationLoading(false);
    }
  };

  // Notification preference functions
  const loadNotificationPreferences = async () => {
    setPreferencesLoading(true);
    try {
      const { data } = await api.get("/api/users/me/notification-preferences", { withCredentials: true });
      setNotificationPreferences(data.preferences || []);
    } catch (err) {
      console.error("Failed to load notification preferences:", err);
      toast.error("Failed to load notification preferences");
    } finally {
      setPreferencesLoading(false);
    }
  };

  const togglePreference = async (typeId: number, enabled: boolean) => {
    setPreferencesSaving(true);
    try {
      await api.put(`/api/users/me/notification-preferences/${typeId}`, 
        { emailEnabled: enabled }, 
        { withCredentials: true }
      );
      
      // Update local state
      setNotificationPreferences(prev => 
        prev.map(pref => 
          pref.notificationTypeId === typeId 
            ? { ...pref, emailEnabled: enabled }
            : pref
        )
      );
      
      toast.success("Preference updated successfully");
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Failed to update preference");
      // Reload preferences to ensure consistency
      loadNotificationPreferences();
    } finally {
      setPreferencesSaving(false);
    }
  };

  const enableAllNotifications = async () => {
    setPreferencesSaving(true);
    try {
      await api.put("/api/users/me/notification-preferences/bulk", 
        { emailEnabled: true }, 
        { withCredentials: true }
      );
      
      // Update local state
      setNotificationPreferences(prev => 
        prev.map(pref => ({ ...pref, emailEnabled: true }))
      );
      
      toast.success("All notifications enabled");
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Failed to enable all notifications");
      loadNotificationPreferences();
    } finally {
      setPreferencesSaving(false);
    }
  };

  const disableAllNotifications = async () => {
    setPreferencesSaving(true);
    try {
      await api.put("/api/users/me/notification-preferences/bulk", 
        { emailEnabled: false }, 
        { withCredentials: true }
      );
      
      // Update local state
      setNotificationPreferences(prev => 
        prev.map(pref => ({ ...pref, emailEnabled: false }))
      );
      
      toast.success("All notifications disabled");
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Failed to disable all notifications");
      loadNotificationPreferences();
    } finally {
      setPreferencesSaving(false);
    }
  };

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      const { data } = await api.get("/api/auth/sessions", { withCredentials: true });
      setSessions(data.sessions || []);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      toast.error("Failed to load session records");
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    api
      .get("/api/me", { withCredentials: true })
      .then((res) => {
        const me = res.data.user ?? res.data;
        // Convert profileImagePath to profileImageUrl using helper
        const userWithImageUrl = {
          ...me,
          profileImageUrl: getAvatarUrlFromUser(me)
        };
        setUser(userWithImageUrl);
        setRole(me.role ?? null);
      })
      .catch((err) => {
        console.error("Not authenticated:", err);
        window.location.href = "/login";
      });
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setCroppedPreview(null);
      setShowCropModal(true);
    }
  };

  const handleCropConfirm = async () => {
    if (!previewUrl || !croppedAreaPixels || !user) return;
    setUploading(true);
    const croppedImage = await getCroppedImg(previewUrl, croppedAreaPixels);
    const blob = await fetch(croppedImage).then((r) => r.blob());
    const croppedFile = new File([blob], "cropped-image.jpg", { type: "image/jpeg" });

    try {
      const fd = new FormData();
      fd.append("image", croppedFile);

      const res = await api.put(`/api/users/${user.id}/profile-image`, fd, {
        withCredentials: true,
      });

      setUser(res.data);
      toast.success(t("uploadOk") || "Profile updated");
    } catch (err: any) {
      toast.error(err.response?.data?.error || t("uploadFail"));
    } finally {
      setUploading(false);
      setShowCropModal(false);
      setCroppedPreview(null);
      setPreviewUrl(null);
      setSelectedFile(null);
    }
  };

  const handleSigChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      toast.error("Please upload PNG files only");
      return;
    }
    setSigFile(file);
    setSigPreviewUrl(URL.createObjectURL(file));
  };

  const handleSigUpload = async () => {
    if (!sigFile || !user) return;
    const fd = new FormData();
    fd.append("file", sigFile);
    try {
      await api.post(`/api/users/${user.id}/signatures`, fd, { withCredentials: true });
      toast.success("Signature uploaded successfully");
      setSigFile(null);
      setSigPreviewUrl(null);
      await loadSignatures(user.id);
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Upload failed");
    }
  };

  if (error) return <p className="text-red-500 text-center mt-6">{error}</p>;
  if (!user) return <p className="text-center mt-6 text-gray-600">{t("loading")}</p>;

  const avatarSrc =
    !imgFailed && user.profileImageUrl ? toSecureUploadUrl(user.profileImageUrl) : "/img/default-avatar.png";

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-4xl font-extrabold text-gray-900 text-center mb-6">{t("myProfile")}</h2>

        {/* Tabs */}
        <div className="mb-10">
          <div className="border-b border-gray-200">
            <nav
              className="flex flex-col sm:flex-row space-y-1 sm:space-y-0 sm:space-x-1 md:space-x-4 overflow-x-auto pb-px"
              aria-label="Tabs"
            >
              <button
                className={`flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                  activeTab === "profile"
                    ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
                onClick={() => setActiveTab("profile")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                </svg>
                <span>{t("tabInfo")}</span>
              </button>

              <button
                className={`flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                  activeTab === "password"
                    ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
                onClick={() => setActiveTab("password")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
                <span>{t("tabPassword")}</span>
              </button>

              <button
                className={`flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                  activeTab === "signature"
                    ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
                onClick={() => setActiveTab("signature")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                </svg>
                <span>{t("tabSignature")}</span>
              </button>

              <button
                className={`hidden flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                  activeTab === "delegation"
                    ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
                onClick={() => setActiveTab("delegation")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z" clipRule="evenodd" />
                </svg>
                <span>{t("tabDelegation") || "Delegation"}</span>
              </button>

              {user?.role !== "user" && (
                <button
                  className={`flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                    activeTab === "notifications"
                      ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                      : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                  }`}
                  onClick={() => setActiveTab("notifications")}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                  </svg>
                  <span>{t("Notifications") || "Notifications"}</span>
                </button>
              )}

              <button
                className={`flex items-center px-4 py-3 whitespace-nowrap text-sm font-medium rounded-t-lg transition-all duration-300 ${
                  activeTab === "sessions"
                    ? "bg-white text-[#145c4a] border-t-2 border-l-2 border-r-2 border-gray-200 shadow-sm -mb-px"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
                onClick={() => setActiveTab("sessions")}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>{t("tabSessions") || "Session Records"}</span>
              </button>
            </nav>
          </div>
        </div>

        {/* PROFILE TAB */}
        {activeTab === "profile" && (
          <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden transition-all duration-300">
            {/* Green Header */}
            <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-6 text-white">
              <h3 className="text-xl font-bold flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-3 text-emerald-200" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                </svg>
                {t("myProfile") || "Personal Information"}
              </h3>
            </div>

            <div className="md:flex">
              {/* Left Column: Avatar & Primary Info */}
              <div className="md:w-1/3 bg-gray-50 p-8 flex flex-col items-center justify-center border-r border-gray-100">
                <div className="relative group inline-block mb-4">
                  {user.profileImageUrl ? (
                    <img
                      src={avatarSrc}
                      alt="Profile"
                      className="w-40 h-40 rounded-full object-cover border-4 border-white shadow-lg"
                      onError={() => setImgFailed(true)}
                    />
                  ) : (
                    <div className="w-40 h-40 rounded-full bg-gray-200 flex items-center justify-center border-4 border-white shadow-lg">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                      </svg>
                    </div>
                  )}
                  
                  {/* Edit Icon Overlay */}
                  <label 
                    htmlFor="profile-upload" 
                    className="absolute bottom-2 right-2 bg-white text-emerald-700 p-2.5 rounded-full shadow-md cursor-pointer hover:bg-emerald-600 hover:text-white transition-all duration-200 transform hover:scale-110 border border-gray-100"
                    title={t("uploadBtn") || "Change Profile Picture"}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </label>
                  <input
                    id="profile-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </div>

                <h1 className="text-2xl font-bold text-gray-900 text-center">
                  {[user.name, user.lastname].filter(Boolean).join(" ")}
                </h1>
                {user.nickname && <p className="text-gray-500 font-medium mt-1">({user.nickname})</p>}
                
                <div className="mt-4 px-4 py-1.5 bg-emerald-100 text-emerald-800 rounded-full text-sm font-semibold">
                  {user.role}
                </div>
              </div>

              {/* Right Column: Details Grid */}
              <div className="md:w-2/3 p-8">
                <div className="grid grid-cols-1 gap-8">
                  {/* Personal Info Group */}
                  <div>
                    <h3 className="text-lg font-bold text-gray-800 mb-4 pb-2 border-b border-gray-100 flex items-center">
                      <span className="bg-gray-100 text-gray-600 p-1.5 rounded-md mr-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                        </svg>
                      </span>
                      {t("sectionPersonal")}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pl-2">
                      <DetailItem label={t("firstname") || "ชื่อ"} value={user.name} />
                      <DetailItem label={t("lastname") || "นามสกุล"} value={user.lastname} />
                      <DetailItem label={t("email")} value={user.email} />
                    </div>
                  </div>

                  {/* Work Info Group */}
                  <div>
                    <h3 className="text-lg font-bold text-gray-800 mb-4 pb-2 border-b border-gray-100 flex items-center">
                      <span className="bg-gray-100 text-gray-600 p-1.5 rounded-md mr-2">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                           <path fillRule="evenodd" d="M6 6V5a3 3 0 013-3h2a3 3 0 013 3v1h2a2 2 0 012 2v3.57A22.952 22.952 0 0110 13a22.95 22.95 0 01-8-1.43V8a2 2 0 012-2h2zm2-1a1 1 0 011-1h2a1 1 0 011 1v1H8V5zm1 5a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1z" clipRule="evenodd" />
                           <path d="M2 13.692V16a2 2 0 002 2h12a2 2 0 002-2v-2.308A24.974 24.974 0 0110 15c-2.796 0-5.487-.46-8-1.308z" />
                         </svg>
                      </span>
                      {t("sectionWork")}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pl-2">
                      <DetailItem label={t("business")} value={user.businessUnit?.name ?? "-"} />
                      <DetailItem label={t("department")} value={user.department?.name ?? "-"} />
                      <DetailItem label={t("role")} value={user.role} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PASSWORD TAB */}
        {activeTab === "password" && (
          <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-6">
              <h3 className="text-xl font-bold text-white flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                {t("pwdTitle")}
              </h3>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                
                if (newPassword.length < 6) {
                  toast.error(t("passwordTooShort") || "Password must be at least 6 characters long");
                  return;
                }

                if (newPassword !== confirmPassword) {
                  toast.error(t("pwdNotMatch") || "New passwords do not match");
                  return;
                }

                setPasswordChanging(true);

                try {
                  await api.put(
                    `/api/users/${user.id}/change-password`,
                    {
                      current: currentPassword,
                      next: newPassword,
                    },
                    { withCredentials: true }
                  );
                  toast.success(t("pwdSuccess") || "Password changed successfully!");
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                } catch (err: any) {
                  toast.error(err.response?.data?.error || t("pwdFail") || "Password change failed");
                } finally {
                  setPasswordChanging(false);
                }
              }}
              className="p-8"
            >
              <div className="space-y-6">
                <div className="relative">
                  <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("currentPwd")}
                  </label>
                  <div className="relative">
                    <input
                      id="currentPassword"
                      name="currentPassword"
                      type={showCurrentPassword ? "text" : "password"}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      disabled={passwordChanging}
                      required
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      disabled={passwordChanging}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-50"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    >
                      {showCurrentPassword ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="relative">
                  <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("newPwd")}
                  </label>
                  <div className="relative">
                    <input
                      id="newPassword"
                      name="newPassword"
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={passwordChanging}
                      required
                      minLength={6}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      disabled={passwordChanging}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-50"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                    >
                      {showNewPassword ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  
                  {/* Password Strength Indicator */}
                  {passwordStrength && (
                    <div className="mt-2">
                      <div className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${passwordStrength.bgColor} ${passwordStrength.color}`}>
                        {passwordStrength.level === 'strong' && (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                        {passwordStrength.level === 'weak' && (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                          </svg>
                        )}
                        {t('passwordStrength') || 'Password Strength'}: {passwordStrength.label}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {passwordStrength.level === 'weak' && (t('passwordStrengthHintWeak') || "Use at least 6 characters")}
                        {passwordStrength.level === 'medium' && (t('passwordStrengthHintMedium') || "Add special characters for stronger security")}
                        {passwordStrength.level === 'strong' && (t('passwordStrengthHintStrong') || "Great! Your password is strong")}
                      </div>
                    </div>
                  )}
                  
                  <p className="text-xs text-gray-500 mt-1">
                    {t('passwordMinLength') || 'Password must be at least 6 characters long'}
                  </p>
                </div>

                <div className="relative">
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("confirmPwd")}
                  </label>
                  <div className="relative">
                    <input
                      id="confirmPassword"
                      name="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={passwordChanging}
                      required
                      minLength={6}
                      className={`w-full border rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        passwordMismatch ? 'border-red-300 bg-red-50' : 'border-gray-300'
                      }`}
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      disabled={passwordChanging}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-50"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    >
                      {showConfirmPassword ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  
                  {/* Password Mismatch Error */}
                  {passwordMismatch && (
                    <div className="mt-2 flex items-center text-red-600 text-sm">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                      {t('passwordMismatch') || 'New Password and Confirm New Password do not match'}
                    </div>
                  )}
                  
                  {/* Password Match Success */}
                  {confirmPassword && !passwordMismatch && confirmPassword.length >= 6 && (
                    <div className="mt-2 flex items-center text-green-600 text-sm">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      {t('passwordMatch') || 'Passwords match'}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-8 flex justify-end">
                <button
                  type="submit"
                  disabled={passwordChanging || passwordMismatch || newPassword.length < 6}
                  className="bg-gradient-to-r from-[#183E33] to-[#145c4a] text-white px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity shadow-md flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {passwordChanging ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                      {t('changingPassword') || 'Changing Password...'}
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      {t("pwdSave")}
                    </>
                  )}
                </button>
              </div>

              {/* Password Requirements Info */}
              <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <p className="text-xs font-medium text-gray-700 mb-2">{t('passwordRequirements') || 'Password Requirements'}:</p>
                <ul className="text-xs text-gray-600 space-y-1">
                  <li className="flex items-center">
                    <span className="w-2 h-2 bg-red-400 rounded-full mr-2"></span>
                    {t('passwordRequirementWeak') || 'Weak: Less than 6 characters'}
                  </li>
                  <li className="flex items-center">
                    <span className="w-2 h-2 bg-yellow-400 rounded-full mr-2"></span>
                    {t('passwordRequirementMedium') || 'Medium: At least 6 characters with letters and numbers'}
                  </li>
                  <li className="flex items-center">
                    <span className="w-2 h-2 bg-green-400 rounded-full mr-2"></span>
                    {t('passwordRequirementStrong') || 'Strong: At least 8 characters with letters, numbers, and special characters'}
                  </li>
                </ul>
              </div>
            </form>
          </div>
        )}

        {/* DELEGATION TAB */}
        {activeTab === "delegation" && (
          <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-6 text-white">
              <h3 className="text-xl font-bold flex items-center">
                <svg className="w-6 h-6 mr-3 text-emerald-200" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z" clipRule="evenodd" />
                </svg>
                {t("delegationTitle") || "Approval Delegation"}
              </h3>
              <p className="text-emerald-100 mt-2 text-sm">
                {t("delegationSubtitle") || "Delegate your approval permissions to another user when you're unavailable"}
              </p>
            </div>

            <div className="p-8">
              <div className="space-y-6">
                {/* Delegated User Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t("delegateToUser") || "Delegate to User"}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder={t("searchUserPlaceholder") || "Search for a user..."}
                      value={userSearchQuery}
                      onChange={(e) => {
                        setUserSearchQuery(e.target.value);
                        loadAvailableUsers(e.target.value);
                      }}
                      onFocus={() => loadAvailableUsers(userSearchQuery)}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all"
                    />
                    
                    {availableUsers.length > 0 && userSearchQuery && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                        {availableUsers.map((availableUser) => (
                          <button
                            key={availableUser.id}
                            type="button"
                            onClick={() => {
                              setDelegatedToUserId(availableUser.id);
                              const fullName = `${availableUser.name} ${availableUser.lastname || ''}`.trim();
                              setDelegatedToUserName(fullName);
                              setUserSearchQuery(fullName);
                              setAvailableUsers([]);
                            }}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center space-x-3"
                          >
                            <div className="w-8 h-8 bg-gradient-to-r from-[#00ffaa] to-[#00cc88] rounded-full flex items-center justify-center text-sm font-bold text-gray-900">
                              {availableUser.name.charAt(0)}{availableUser.lastname?.charAt(0) || ''}
                            </div>
                            <div>
                              <div className="font-medium text-gray-900">
                                {availableUser.name} {availableUser.lastname || ''}
                              </div>
                              <div className="text-sm text-gray-500">{availableUser.email}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  {delegatedToUserId && (
                    <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-gradient-to-r from-[#00ffaa] to-[#00cc88] rounded-full flex items-center justify-center text-sm font-bold text-gray-900">
                            {availableUsers.find(u => u.id === delegatedToUserId)?.name.charAt(0) || 'U'}
                          </div>
                          <div>
                            <div className="font-medium text-emerald-900">
                              {t("selected") || "Selected:"} {delegatedToUserName || availableUsers.find(u => u.id === delegatedToUserId)?.name || userSearchQuery}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setDelegatedToUserId(null);
                            setDelegatedToUserName("");
                            setUserSearchQuery("");
                          }}
                          className="text-emerald-600 hover:text-emerald-800"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Date Range */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t("startDate") || "Start Date"}
                    </label>
                    <input
                      type="datetime-local"
                      value={delegationStartDate}
                      onChange={(e) => setDelegationStartDate(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t("endDate") || "End Date"}
                    </label>
                    <input
                      type="datetime-local"
                      value={delegationEndDate}
                      onChange={(e) => setDelegationEndDate(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all"
                    />
                  </div>
                </div>

                {/* Current Status */}
                {delegatedToUserId && delegationStartDate && delegationEndDate && (
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <h4 className="font-medium text-blue-900 mb-2">{t("currentDelegationStatus") || "Current Delegation Status"}</h4>
                    <p className="text-blue-800 text-sm">
                      {t("delegationStatusDescPart1") || "Your approval permissions will be delegated to"} <strong>{delegatedToUserName}</strong> {t("delegationStatusDescPart2") || "from"}{' '}
                      <strong>{new Date(delegationStartDate).toLocaleString()}</strong> {t("delegationStatusDescPart3") || "to"}{' '}
                      <strong>{new Date(delegationEndDate).toLocaleString()}</strong>
                    </p>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex justify-end space-x-4">
                  <button
                    type="button"
                    onClick={clearDelegation}
                    disabled={delegationLoading}
                    className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-all disabled:opacity-50"
                  >
                    {t("clearDelegation") || "Clear Delegation"}
                  </button>
                  
                  <button
                    type="button"
                    onClick={saveDelegation}
                    disabled={delegationLoading || !delegatedToUserId || !delegationStartDate || !delegationEndDate}
                    className="px-6 py-3 bg-gradient-to-r from-[#183E33] to-[#145c4a] text-white rounded-lg hover:opacity-90 transition-all disabled:opacity-50 flex items-center"
                  >
                    {delegationLoading && (
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {t("saveDelegation") || "Save Delegation"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* NOTIFICATIONS TAB */}
        {activeTab === "notifications" && user?.role !== "user" && (
          <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden border border-gray-100">
            <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-8 text-white">
              <h3 className="text-2xl font-bold flex items-center">
                <svg className="w-7 h-7 mr-3 text-emerald-200" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                </svg>
                {t("Email Notification Preferences") || "การตั้งค่าการแจ้งเตือนทางอีเมล"}
              </h3>
              <p className="text-emerald-50 mt-2 text-sm max-w-2xl opacity-90">
                {t("Choose which email notifications you want to receive") || "เลือกประเภทการแจ้งเตือนทางอีเมลที่คุณต้องการรับ"}
              </p>
            </div>

            <div className="p-0">
              {preferencesLoading ? (
                <div className="flex justify-center items-center py-20">
                  <div className="flex flex-col items-center">
                    <svg className="animate-spin h-10 w-10 text-[#145c4a] mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="text-gray-500 font-medium tracking-wide">{t("loading") || "Loading..."}</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col md:flex-row min-h-[500px]">
                  {/* Sidebar Categories */}
                  <div className="w-full md:w-[300px] bg-slate-50 border-r border-gray-100 p-6 flex flex-col pt-8 space-y-1.5 shrink-0">
                    <button
                      onClick={() => setActiveNotifCategory("Approval")}
                      className={`text-left px-5 py-3.5 rounded-xl font-medium transition-all duration-200 flex items-center group relative overflow-hidden ${
                        activeNotifCategory === "Approval"
                          ? "bg-white text-[#183E33] shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-gray-200"
                          : "text-gray-600 hover:bg-slate-100 border border-transparent"
                      }`}
                    >
                      {activeNotifCategory === "Approval" && (
                         <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#183E33] rounded-r-full"></div>
                      )}
                      <svg className={`w-5 h-5 mr-3 transition-colors ${activeNotifCategory === "Approval" ? "text-[#183E33]" : "text-gray-400 group-hover:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      {t("Approval Notifications") || "Approval Notifications"}
                    </button>

                    <button
                      onClick={() => setActiveNotifCategory("DocumentStatus")}
                      className={`text-left px-5 py-3.5 rounded-xl font-medium transition-all duration-200 flex items-center group relative overflow-hidden ${
                        activeNotifCategory === "DocumentStatus"
                          ? "bg-white text-[#183E33] shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-gray-200"
                          : "text-gray-600 hover:bg-slate-100 border border-transparent"
                      }`}
                    >
                      {activeNotifCategory === "DocumentStatus" && (
                         <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#183E33] rounded-r-full"></div>
                      )}
                      <svg className={`w-5 h-5 mr-3 transition-colors ${activeNotifCategory === "DocumentStatus" ? "text-[#183E33]" : "text-gray-400 group-hover:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                      {t("Document Status Notifications") || "Document Status Notifications"}
                    </button>

                    <button
                      onClick={() => setActiveNotifCategory("Comment")}
                      className={`text-left px-5 py-3.5 rounded-xl font-medium transition-all duration-200 flex items-center group relative overflow-hidden ${
                        activeNotifCategory === "Comment"
                          ? "bg-white text-[#183E33] shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-gray-200"
                          : "text-gray-600 hover:bg-slate-100 border border-transparent"
                      }`}
                    >
                      {activeNotifCategory === "Comment" && (
                         <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#183E33] rounded-r-full"></div>
                      )}
                      <svg className={`w-5 h-5 mr-3 transition-colors ${activeNotifCategory === "Comment" ? "text-[#183E33]" : "text-gray-400 group-hover:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                      {t("Comment Notifications") || "Comment Notifications"}
                    </button>
                  </div>

                  {/* Preferences Content */}
                  <div className="flex-1 p-4 bg-white">
                     {/* Bulk Actions */}
                      <div className="flex justify-end gap-3 mb-6">
                        <button
                          onClick={enableAllNotifications}
                          disabled={preferencesSaving}
                          className="px-5 py-2.5 bg-white border border-[#145c4a] text-[#145c4a] font-medium rounded-lg hover:bg-[#145c4a] hover:text-white transition-all disabled:opacity-50 flex items-center shadow-sm hover:shadow"
                        >
                          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          {t("Enable All") || "เปิดทั้งหมด"}
                        </button>
                        <button
                          onClick={disableAllNotifications}
                          disabled={preferencesSaving}
                          className="px-5 py-2.5 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-all disabled:opacity-50 flex items-center shadow-sm hover:shadow"
                        >
                          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          {t("Disable All") || "ปิดทั้งหมด"}
                        </button>
                      </div>

                    <div className="space-y-3">
                      {notificationPreferences
                        .filter((pref) => {
                           const slug = pref.notificationTypeSlug;
                           if (activeNotifCategory === "Approval") {
                             return ["wait-for-your-turn", "cc-notification", "add-extra-approval", "remove-extra-approval", "approve-with-condition"].includes(slug);
                           }
                           if (activeNotifCategory === "DocumentStatus") {
                             return ["status-approved", "status-rejected", "status-terminated", "status-recalled", "status-expired", "near-expiry"].includes(slug);
                           }
                           if (activeNotifCategory === "Comment") {
                             return ["new-comment", "tagged-in-comment", "others-mentioned", "removed-mention"].includes(slug);
                           }
                           return false;
                        })
                        .map((pref) => (
                        <div
                          key={pref.notificationTypeId}
                          className="flex items-center justify-between p-5 border border-gray-200 rounded-xl transition-all duration-200 shadow-sm"
                        >
                          <div className="flex-1 pr-4">
                            <h4 className="font-semibold text-gray-800 tracking-tight">{pref.notificationTypeName}</h4>
                            {pref.notificationTypeDescription && (
                              <p className="text-sm text-gray-500 mt-1.5 leading-snug">{pref.notificationTypeDescription}</p>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-3">
                            <span className={`text-sm font-medium ${pref.emailEnabled ? 'text-[#183E33]' : 'text-gray-500'}`}>
                              {pref.emailEnabled ? (t("Enabled") || "Enabled") : (t("Disabled") || "Disabled")}
                            </span>
                            <button
                              onClick={() => togglePreference(pref.notificationTypeId, !pref.emailEnabled)}
                              disabled={preferencesSaving}
                              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus:ring-2 focus:ring-[#145c4a] focus:ring-offset-2 disabled:opacity-50 ${
                                pref.emailEnabled ? 'bg-[#183E33]' : 'bg-gray-200 hover:bg-gray-300'
                              }`}
                            >
                              <span
                                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-300 ease-in-out shadow-sm ${
                                  pref.emailEnabled ? 'translate-x-[22px]' : 'translate-x-1'
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {notificationPreferences.length === 0 && (
                      <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-xl bg-gray-50 mt-4">
                        <svg className="h-12 w-12 mx-auto text-gray-400 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                        </svg>
                        <h3 className="mt-4 font-medium text-gray-600">
                          {t("No notification types available") || "ไม่มีประเภทการแจ้งเตือนให้ตั้งค่า"}
                        </h3>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

{/* SIGNATURE TAB */}
{activeTab === "signature" && (
  <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
    <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-6 text-white">
      <h3 className="text-xl font-bold flex items-center">
        <svg className="w-6 h-6 mr-3 text-emerald-200" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
        </svg>
        {t("tabSignature")}
      </h3>
    </div>

    {/* Default Signature Text Section */}
    <div className="p-6 border-b border-gray-200">
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
        <div className="px-4 py-3 bg-gray-600 flex justify-between items-center">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
            {t("setDefaultSignatureText")}
          </h3>
        </div>

        <div className="p-4 bg-white">
          <p className="text-sm text-gray-600 mb-4">
            {t("defaultSignatureTextDesc")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={defaultSignatureText}
              onChange={(e) => setDefaultSignatureText(e.target.value)}
              placeholder={t("defaultSignatureTextPlaceholder")}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition duration-200"
            />
            <button
              onClick={saveDefaultSignatureText}
              disabled={defaultSigTextSaving}
              className="px-6 py-2.5 bg-gray-600 text-white font-medium rounded-lg hover:from-gray-700 hover:to-gray-600 transition duration-200 disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
            >
              {defaultSigTextSaving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  {t("saving") || "Saving..."}
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  {t("save") || "Save"}
                </>
              )}
            </button>
          </div>

          {/* Signature Preview */}
          <div className="mt-6">
             <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
               {t("signaturePreview")}
             </label>
             <div className="p-8 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center min-h-[120px] transition-all duration-300 hover:border-emerald-200 hover:bg-emerald-50/10">
               <p 
                 className="text-5xl text-gray-800" 
                 style={{ fontFamily: "'Allura', cursive" }}
               >
                 {defaultSignatureText || user?.name || "Your Signature"}
               </p>
             </div>
          </div>
        </div>
      </div>
    </div>

    {/* Drawing Canvas Section */}
    <div className="p-6 border-b border-gray-200">
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
        <div className="px-4 py-3 bg-emerald-600  flex justify-between items-center">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
            {t("drawingCanvas")}
          </h3>
        </div>

        <SignatureCanvas
          ref={sigPadRef}
          penColor={penColor}
          minWidth={penWidth}
          maxWidth={penWidth}
          backgroundColor="rgba(255,255,255,0)"
          canvasProps={{
            className: "w-full h-56 bg-white border-b border-gray-200",
            style: { cursor: "crosshair" },
          }}
        />

        <div className="p-4 bg-white border-t border-gray-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Colors */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-600" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className="text-sm font-medium text-gray-700">{t("colors")}</span>
              </div>
              <div className="flex items-center gap-3">
                {[
                  { color: "#000000", name: "Black" },
                  { color: "#183E33", name: "Green" },
                  { color: "#FF0000", name: "Red" },
                  { color: "#0066FF", name: "Blue" },
                ].map((c) => (
                  <div key={c.color} className="flex flex-col items-center">
                    <button
                      onClick={() => setPenColor(c.color)}
                      className={`h-8 w-8 rounded-full border-2 flex-shrink-0 transition-all duration-200 hover:scale-105 ${
                        penColor === c.color ? "ring-2 ring-emerald-400 ring-offset-1" : "border-gray-300 hover:border-gray-400"
                      }`}
                      style={{ backgroundColor: c.color }}
                      aria-label={`Select ${c.name} color`}
                    />
                    <span className="text-xs text-gray-500 mt-1">
                      {c.name === "Black" && t("colorBlack")}
                      {c.name === "Green" && t("colorGreen")}
                      {c.name === "Red" && t("colorRed")}
                      {c.name === "Blue" && t("colorBlue")}
                    </span>
                  </div>
                ))}
                <div className="flex flex-col items-center">
                  <label className="relative cursor-pointer">
                    <input
                      type="color"
                      value={penColor}
                      onChange={(e) => setPenColor(e.target.value)}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                    <div className="h-8 w-8 flex items-center justify-center rounded-full border-2 border-gray-300 hover:border-gray-400 transition">
                      <IoColorPaletteSharp size={20} className="text-gray-600" />
                    </div>
                  </label>
                  <span className="text-xs text-gray-500 mt-1">{t("colorCustom")}</span>
                </div>
              </div>
            </div>

            {/* Brush Size */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <FaPaintbrush className="h-4 w-4 text-gray-600" />
                <span className="text-sm font-medium text-gray-700">{t("brushSize")}</span>
              </div>
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={penWidth}
                  onChange={(e) => setPenWidth(Number(e.target.value))}
                  className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
                <div className="flex items-center justify-center h-8 w-8 rounded-md bg-emerald-50 border border-emerald-200 text-sm font-medium text-emerald-800">
                  {penWidth}
                </div>
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-end">
            <button
              onClick={clearDraw}
              className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg transition duration-200 shadow-sm hover:shadow"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9z"
                  clipRule="evenodd"
                />
              </svg>
              {t("clearCanvas")}
            </button>
            <button
              onClick={saveDrawn}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600  text-white rounded-lg hover:from-emerald-700 hover:to-teal-700 transition duration-200 shadow-sm hover:shadow"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {t("saveAsPng")}
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* Upload Section */}
    <div className="hidden p-6 border-b border-gray-200">
      <h4 className="font-medium text-gray-700 mb-4 flex items-center">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
        {t("uploadSignature")}
      </h4>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-emerald-500 hover:bg-emerald-50/50 transition duration-200 bg-gray-50">
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              {sigPreviewUrl ? (
                <div className="relative w-full h-full flex items-center justify-center p-2">
                  <img 
                    src={sigPreviewUrl} 
                    alt="Signature Preview" 
                    className="max-h-full max-w-full object-contain" 
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 opacity-0 hover:opacity-100 transition-opacity rounded-lg">
                     <span className="text-white text-sm font-medium">{t("clickToChange")}</span>
                  </div>
                </div>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-400 mb-2" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4zm6 9a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                  </svg>
                  <p className="text-sm text-gray-500">
                    <span className="font-semibold">{t("Click to upload") || "คลิกเพื่ออัปโหลด"}</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{t("PNG or SVG (max size 5MB)") || "PNG หรือ SVG (ขนาดสูงสุด 5MB)"}</p>
                </>
              )}
            </div>
            <input type="file" accept="image/png" onChange={handleSigChange} className="hidden" />
          </label>
        </div>

        <button
          disabled={!sigFile}
          onClick={handleSigUpload}
          className={`px-6 py-3 h-full rounded-lg font-medium transition w-full sm:w-auto ${
            sigFile ? "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-sm hover:shadow" : "bg-gray-200 text-gray-400 cursor-not-allowed"
          }`}
        >
          {t("sigSave") || "บันทึกลายเซ็น"}
        </button>
      </div>
    </div>

    {/* Gallery Section */}
    <div className="p-6">
      <h4 className="font-medium text-gray-700 mb-4 flex items-center">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z"
            clipRule="evenodd"
          />
        </svg>
        {t("signatureGallery") || "แกลเลอรี่ลายเซ็น"}
      </h4>

      {signatures.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-xl bg-gray-50">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
          <h3 className="mt-4 font-medium text-gray-500">{t("sigEmpty") || "ยังไม่มีลายเซ็น"}</h3>
          <p className="text-sm text-gray-400 mt-1">{t("Start by drawing or uploading your signature") || "เริ่มโดยการวาดหรืออัปโหลดลายเซ็นของคุณ"}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {signatures.map((sig) => (
            <div
              key={sig.id}
              className={`relative bg-white border rounded-xl overflow-hidden transition-all duration-200 ${
                sig.id === defaultSigId ? "border-emerald-500 shadow-md" : "border-gray-200 hover:border-emerald-300 hover:shadow-md"
              }`}
            >
              <div className="h-40 flex items-center justify-center bg-gray-50 p-4">
                <img src={`/api/users/signatures/${sig.id}/file`} alt="signature" className="max-h-full max-w-full object-contain" />
              </div>

              <div className="p-3 bg-white border-t border-gray-100 flex justify-between items-center">
                {sig.label && <span className="inline-block px-2 py-1 text-xs font-medium bg-emerald-100 text-emerald-800 rounded-full">{sig.label}</span>}

                <div className="flex gap-2">
                  <button
                    onClick={() => deleteSig(sig.id)}
                    className="p-1.5 text-gray-500 hover:text-red-600 rounded-full hover:bg-red-50 transition duration-200"
                    title={t("delete")}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>

                  <button
                    onClick={async () => {
                      const newDefault = sig.id === defaultSigId ? null : sig.id;
                      try {
                        await setDefault(user!.id, newDefault);
                        toast.success("Default signature set successfully");
                      } catch (err) {
                        toast.error("Failed to set default signature");
                      }
                    }}
                    className={`p-1.5 rounded-full transition duration-200 ${
                      sig.id === defaultSigId ? "text-amber-500 hover:bg-amber-50" : "text-gray-500 hover:text-amber-500 hover:bg-amber-50"
                    }`}
                  >
                    {sig.id === defaultSigId ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {sig.id === defaultSigId && (
                <div className="absolute top-2 right-2 bg-emerald-500 text-white text-xs px-2 py-1 rounded-full flex items-center shadow">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  Default
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
)}

        {/* SESSIONS TAB */}
        {activeTab === "sessions" && (
          <div className="max-w-6xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-[#183E33] to-[#145c4a] p-6 text-white">
              <h3 className="text-xl font-bold flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 mr-3 text-emerald-200" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                {t("sessionsTitle") || "Login Session Records"}
              </h3>
              <p className="text-emerald-100 mt-2 text-sm">
                {t("sessionsSubtitle") || "Your recent login activities"}
              </p>
            </div>

            <div className="p-6">
              {sessionsLoading ? (
                <div className="flex justify-center items-center py-12">
                  <svg className="animate-spin h-8 w-8 text-[#145c4a]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : (
                <>
                  {/* Column Filters */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t("sessionStatus") || "Status"}</label>
                      <select
                        value={sessionFilterStatus}
                        onChange={(e) => setSessionFilterStatus(e.target.value as "all" | "active" | "closed")}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a]"
                      >
                        <option value="all">{t("filterAll") || "All"}</option>
                        <option value="active">{t("sessionActive") || "Active"}</option>
                        <option value="closed">{t("sessionClosed") || "Closed"}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t("sessionIp") || "IP Address"}</label>
                      <input
                        type="text"
                        placeholder={t("filterIp") || "Search IP..."}
                        value={sessionFilterIp}
                        onChange={(e) => setSessionFilterIp(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t("filterFrom") || "From"}</label>
                      <input
                        type="date"
                        value={sessionFilterFrom}
                        onChange={(e) => setSessionFilterFrom(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t("filterTo") || "To"}</label>
                      <input
                        type="date"
                        value={sessionFilterTo}
                        onChange={(e) => setSessionFilterTo(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a]"
                      />
                    </div>
                  </div>

                  {/* Device filter + Clear */}
                  <div className="flex flex-col sm:flex-row gap-3 mb-6">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t("sessionDevice") || "Device / Browser"}</label>
                      <input
                        type="text"
                        placeholder={t("filterDevice") || "Search device..."}
                        value={sessionFilterDevice}
                        onChange={(e) => setSessionFilterDevice(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a]"
                      />
                    </div>
                    {(sessionFilterIp || sessionFilterDevice || sessionFilterStatus !== "all" || sessionFilterFrom || sessionFilterTo) && (
                      <div className="flex items-end">
                        <button
                          onClick={() => {
                            setSessionFilterIp("");
                            setSessionFilterDevice("");
                            setSessionFilterStatus("all");
                            setSessionFilterFrom("");
                            setSessionFilterTo("");
                          }}
                          className="px-4 py-2 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-all"
                        >
                          {t("filterClear") || "Clear Filters"}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Table */}
                  {(() => {
                    const filtered = sessions.filter((s) => {
                      if (sessionFilterStatus === "active" && s.logoutAt !== null) return false;
                      if (sessionFilterStatus === "closed" && s.logoutAt === null) return false;
                      if (sessionFilterIp && !(s.ipAddress ?? "").toLowerCase().includes(sessionFilterIp.toLowerCase())) return false;
                      if (sessionFilterDevice && !(s.userAgent ?? "").toLowerCase().includes(sessionFilterDevice.toLowerCase())) return false;
                      if (sessionFilterFrom && new Date(s.loginAt) < new Date(sessionFilterFrom)) return false;
                      if (sessionFilterTo) {
                        const to = new Date(sessionFilterTo);
                        to.setHours(23, 59, 59, 999);
                        if (new Date(s.loginAt) > to) return false;
                      }
                      return true;
                    });

                    if (filtered.length === 0) {
                      return (
                        <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-xl bg-gray-50">
                          <svg className="h-12 w-12 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <h3 className="mt-4 font-medium text-gray-500">{t("sessionsEmpty") || "No session records found"}</h3>
                        </div>
                      );
                    }

                    return (
                      <div className="overflow-x-auto rounded-xl border border-gray-200">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-12">#</th>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("sessionLoginAt") || "Login Time"}</th>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("sessionLogoutAt") || "Logout Time"}</th>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("sessionIp") || "IP Address"}</th>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("sessionDevice") || "Device / Browser"}</th>
                              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("sessionStatus") || "Status"}</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-100">
                            {filtered.map((session, index) => (
                              <tr key={session.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-4 py-3 text-gray-400">{index + 1}</td>
                                <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                                  {new Date(session.loginAt).toLocaleString()}
                                </td>
                                <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                                  {session.logoutAt ? new Date(session.logoutAt).toLocaleString() : "-"}
                                </td>
                                <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                                  {session.ipAddress ?? "-"}
                                </td>
                                <td className="px-4 py-3 text-gray-500 max-w-xs truncate" title={session.userAgent ?? ""}>
                                  {session.userAgent ?? "-"}
                                </td>
                                <td className="px-4 py-3">
                                  {session.logoutAt === null ? (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5"></span>
                                      {t("sessionActive") || "Active"}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                                      {t("sessionClosed") || "Closed"}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        )}

        {/* CROP MODAL */}
        <Modal
          isOpen={showCropModal}
          onRequestClose={() => setShowCropModal(false)}
          className="bg-white rounded-xl p-4 max-w-xl mx-auto shadow-xl mt-20 outline-none"
        >
          <h2 className="text-xl font-bold mb-4">{t("cropTitle")}</h2>
          <div className="relative w-full h-64 bg-gray-100">
            <Cropper
              image={previewUrl!}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, cropped) => {
                setCroppedAreaPixels(cropped);
                if (previewUrl) getCroppedImg(previewUrl, cropped).then(setCroppedPreview);
              }}
            />
          </div>

          {croppedPreview && (
            <div className="mt-4 flex justify-center">
              <img src={croppedPreview} alt="crop preview" className="w-28 h-28 rounded-full border shadow-inner object-cover" />
            </div>
          )}
          <div className="flex justify-end mt-4 space-x-2">
            <button
              className="px-4 py-1 text-sm rounded bg-gray-300"
              onClick={() => {
                setShowCropModal(false);
                setCroppedPreview(null);
              }}
            >
              {t("Cancel") || "ยกเลิก"}
            </button>
            <button className="px-4 py-1 text-sm rounded bg-green-600 text-white" onClick={handleCropConfirm} disabled={uploading}>
              {uploading ? t("loading") || "กำลังบันทึก…" : t("Confirm") || "ตกลง"}
            </button>
          </div>
        </Modal>
      </div>
    </div>
  );
};

const DetailItem: React.FC<{ label: string; value?: string | null }> = ({ label, value }) => (
  <div className="flex flex-col space-y-1">
    <span className="text-sm font-medium text-gray-500">{label}</span>
    <span className="text-lg text-gray-900 font-semibold">{value || "-"}</span>
  </div>
);

export default ProfilePage;
