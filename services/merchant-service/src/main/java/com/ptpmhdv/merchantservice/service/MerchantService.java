package com.ptpmhdv.merchantservice.service;

import com.ptpmhdv.merchantservice.dto.*;
import com.ptpmhdv.merchantservice.model.MerchantStatus;

public interface MerchantService {
    MerchantResponse registerMerchant(RegisterMerchantRequest request, String ownerId);
    MerchantResponse getMerchantById(String id);
    MerchantResponse updateMerchant(String id, UpdateMerchantRequest request, String currentUserId, String currentRole);
    MerchantResponse updateMerchantStatus(String id, UpdateMerchantStatusRequest request, Boolean isInternalCall, String currentRole);
    MerchantActiveResponse checkMerchantActive(String id);
    PageResponse<MerchantResponse> getMerchants(MerchantStatus status, String search, int page, int limit, String currentRole);
}
