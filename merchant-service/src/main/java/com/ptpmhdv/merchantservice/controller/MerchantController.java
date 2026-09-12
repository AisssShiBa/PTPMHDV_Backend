package com.ptpmhdv.merchantservice.controller;

import com.ptpmhdv.merchantservice.dto.*;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import com.ptpmhdv.merchantservice.service.MerchantService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/merchants")
@RequiredArgsConstructor
@Tag(name = "Merchant Management", description = "Merchant onboarding, profile management, and status verification APIs")
public class MerchantController {

    private final MerchantService merchantService;

    @PostMapping("/register")
    @Operation(summary = "Register merchant profile", description = "Submit merchant onboarding application (Default status: PENDING)")
    public ResponseEntity<ApiResponse<MerchantResponse>> registerMerchant(
            @Valid @RequestBody RegisterMerchantRequest request,
            HttpServletRequest httpRequest) {
        String ownerId = (String) httpRequest.getAttribute("userId");
        MerchantResponse response = merchantService.registerMerchant(request, ownerId);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.success(response, "Merchant registration submitted successfully"));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get merchant profile by ID", description = "Fetch merchant details by UUID String")
    public ResponseEntity<ApiResponse<MerchantResponse>> getMerchantById(@PathVariable String id) {
        MerchantResponse response = merchantService.getMerchantById(id);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update merchant profile", description = "Update business name, tax ID, or bank account")
    public ResponseEntity<ApiResponse<MerchantResponse>> updateMerchant(
            @PathVariable String id,
            @RequestBody UpdateMerchantRequest request,
            HttpServletRequest httpRequest) {
        String currentUserId = (String) httpRequest.getAttribute("userId");
        String currentRole = (String) httpRequest.getAttribute("userRole");
        MerchantResponse response = merchantService.updateMerchant(id, request, currentUserId, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response, "Merchant profile updated successfully"));
    }

    @PatchMapping("/{id}/status")
    @Operation(summary = "Update merchant status (Admin / Internal)", description = "Approve or reject a merchant profile")
    public ResponseEntity<ApiResponse<MerchantResponse>> updateMerchantStatus(
            @PathVariable String id,
            @Valid @RequestBody UpdateMerchantStatusRequest request,
            HttpServletRequest httpRequest) {
        Boolean isInternalCall = (Boolean) httpRequest.getAttribute("isInternalCall");
        String currentRole = (String) httpRequest.getAttribute("userRole");
        MerchantResponse response = merchantService.updateMerchantStatus(id, request, isInternalCall, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response, "Merchant status updated to " + request.getStatus()));
    }

    @GetMapping("/{id}/active")
    @Operation(summary = "Check merchant active status (Internal Payment Service)", description = "Endpoint called by payment-service before processing payments")
    public ResponseEntity<ApiResponse<MerchantActiveResponse>> checkMerchantActive(@PathVariable String id) {
        MerchantActiveResponse response = merchantService.checkMerchantActive(id);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @GetMapping
    @Operation(summary = "List merchants with status filter & pagination (Admin only)", description = "Admin merchant directory and approval list")
    public ResponseEntity<ApiResponse<PageResponse<MerchantResponse>>> getMerchants(
            @RequestParam(required = false) MerchantStatus status,
            @RequestParam(required = false) String search,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int limit,
            HttpServletRequest httpRequest) {
        String currentRole = (String) httpRequest.getAttribute("userRole");
        PageResponse<MerchantResponse> response = merchantService.getMerchants(status, search, page, limit, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response));
    }
}
