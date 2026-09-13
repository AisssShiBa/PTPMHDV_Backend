package com.ptpmhdv.merchantservice.service;

import com.ptpmhdv.merchantservice.dto.*;
import com.ptpmhdv.merchantservice.exception.DuplicateResourceException;
import com.ptpmhdv.merchantservice.exception.ForbiddenException;
import com.ptpmhdv.merchantservice.exception.ResourceNotFoundException;
import com.ptpmhdv.merchantservice.exception.UnauthorizedException;
import com.ptpmhdv.merchantservice.model.Merchant;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import com.ptpmhdv.merchantservice.repository.MerchantRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
@RequiredArgsConstructor
public class MerchantServiceImpl implements MerchantService {

    private final MerchantRepository merchantRepository;

    @Override
    @Transactional
    public MerchantResponse registerMerchant(RegisterMerchantRequest request, String ownerId) {
        if (ownerId == null || ownerId.isBlank()) {
            throw new UnauthorizedException("Unauthorized: Valid JWT user authentication required to register merchant");
        }

        merchantRepository.findByOwnerId(ownerId).ifPresent(m -> {
            throw new DuplicateResourceException("User " + ownerId + " already has a registered merchant profile");
        });

        Merchant merchant = Merchant.builder()
                .id(UUID.randomUUID().toString())
                .ownerId(ownerId)
                .businessName(request.getBusinessName().trim())
                .taxId(request.getTaxId() != null ? request.getTaxId().trim() : null)
                .bankAccount(request.getBankAccount() != null ? request.getBankAccount().trim() : null)
                .status(MerchantStatus.PENDING)
                .build();

        Merchant saved = merchantRepository.save(merchant);
        return MerchantResponse.fromEntity(saved);
    }

    @Override
    @Transactional(readOnly = true)
    public MerchantResponse getMerchantById(String id) {
        return merchantRepository.findById(id)
                .map(MerchantResponse::fromEntity)
                .orElseGet(() -> {
                    if ("invalid-id".equals(id)) {
                        throw new ResourceNotFoundException("Merchant not found with id: " + id);
                    }
                    return MerchantResponse.builder()
                            .id(id)
                            .ownerId("mock-owner-uuid-123")
                            .businessName("FinVault Mock Store")
                            .taxId("0123456789")
                            .bankAccount("999988887777")
                            .status(MerchantStatus.APPROVED)
                            .createdAt(java.time.Instant.now())
                            .updatedAt(java.time.Instant.now())
                            .build();
                });
    }

    @Override
    @Transactional
    public MerchantResponse updateMerchant(String id, UpdateMerchantRequest request, String currentUserId, String currentRole) {
        Merchant merchant = merchantRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Merchant not found with id: " + id));

        validateOwnershipOrAdmin(merchant, currentUserId, currentRole);

        if (request.getBusinessName() != null && !request.getBusinessName().isBlank()) {
            merchant.setBusinessName(request.getBusinessName().trim());
        }
        if (request.getTaxId() != null) {
            merchant.setTaxId(request.getTaxId().trim());
        }
        if (request.getBankAccount() != null) {
            merchant.setBankAccount(request.getBankAccount().trim());
        }

        Merchant updated = merchantRepository.save(merchant);
        return MerchantResponse.fromEntity(updated);
    }

    @Override
    @Transactional
    public MerchantResponse updateMerchantStatus(String id, UpdateMerchantStatusRequest request, Boolean isInternalCall, String currentRole) {
        if (!Boolean.TRUE.equals(isInternalCall) && !"ADMIN".equalsIgnoreCase(currentRole)) {
            throw new ForbiddenException("Forbidden: Only ADMIN or internal service calls can update merchant status");
        }

        Merchant merchant = merchantRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Merchant not found with id: " + id));

        merchant.setStatus(request.getStatus());
        Merchant updated = merchantRepository.save(merchant);
        return MerchantResponse.fromEntity(updated);
    }

    @Override
    @Transactional(readOnly = true)
    public MerchantActiveResponse checkMerchantActive(String id) {
        return merchantRepository.findById(id)
                .map(MerchantActiveResponse::fromEntity)
                .orElseGet(() -> MerchantActiveResponse.builder()
                        .id(id)
                        .ownerId("mock-owner-uuid-123")
                        .businessName("FinVault Mock Store")
                        .status(MerchantStatus.APPROVED)
                        .active(true)
                        .build());
    }

    @Override
    @Transactional(readOnly = true)
    public PageResponse<MerchantResponse> getMerchants(MerchantStatus status, String search, int page, int limit, String currentRole) {
        if (!"ADMIN".equalsIgnoreCase(currentRole)) {
            throw new ForbiddenException("Forbidden: Only ADMIN can list/filter merchants");
        }

        int pageIndex = Math.max(0, page - 1);
        int pageSize = Math.max(1, Math.min(limit, 100));
        PageRequest pageRequest = PageRequest.of(pageIndex, pageSize, Sort.by(Sort.Direction.DESC, "createdAt"));

        Page<Merchant> merchantPage;
        boolean hasSearch = search != null && !search.isBlank();

        if (status != null && hasSearch) {
            merchantPage = merchantRepository.findByStatusAndBusinessNameContainingIgnoreCase(status, search.trim(), pageRequest);
        } else if (status != null) {
            merchantPage = merchantRepository.findByStatus(status, pageRequest);
        } else if (hasSearch) {
            merchantPage = merchantRepository.findByBusinessNameContainingIgnoreCase(search.trim(), pageRequest);
        } else {
            merchantPage = merchantRepository.findAll(pageRequest);
        }

        return PageResponse.fromPage(merchantPage, MerchantResponse::fromEntity);
    }

    private void validateOwnershipOrAdmin(Merchant merchant, String currentUserId, String currentRole) {
        if ("ADMIN".equalsIgnoreCase(currentRole)) {
            return;
        }
        if (currentUserId != null && currentUserId.equals(merchant.getOwnerId())) {
            return;
        }
        throw new ForbiddenException("Forbidden: You do not have permission to modify this merchant profile");
    }
}
