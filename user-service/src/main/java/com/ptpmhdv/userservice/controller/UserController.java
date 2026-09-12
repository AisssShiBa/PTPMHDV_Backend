package com.ptpmhdv.userservice.controller;

import com.ptpmhdv.userservice.dto.*;
import com.ptpmhdv.userservice.service.UserService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
@Tag(name = "User Management", description = "User profile and KYC management APIs")
public class UserController {

    private final UserService userService;

    @PostMapping
    @Operation(summary = "Create user profile (Internal)", description = "Called internally by auth-service after signup with X-Internal-Key header")
    public ResponseEntity<ApiResponse<UserResponse>> createUser(
            @Valid @RequestBody CreateUserRequest request,
            HttpServletRequest httpRequest) {
        Boolean isInternalCall = (Boolean) httpRequest.getAttribute("isInternalCall");
        UserResponse response = userService.createUser(request, isInternalCall);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.success(response, "User profile created successfully"));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get user profile by ID", description = "Fetch user profile details by User UUID String")
    public ResponseEntity<ApiResponse<UserResponse>> getUserById(@PathVariable String id) {
        UserResponse response = userService.getUserById(id);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @GetMapping("/by-auth/{authUserId}")
    @Operation(summary = "Get user profile by Auth User ID", description = "Fetch user profile details by Auth User ID")
    public ResponseEntity<ApiResponse<UserResponse>> getUserByAuthUserId(@PathVariable String authUserId) {
        UserResponse response = userService.getUserByAuthUserId(authUserId);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update user profile", description = "Update full name, phone, or address")
    public ResponseEntity<ApiResponse<UserResponse>> updateUser(
            @PathVariable String id,
            @RequestBody UpdateUserRequest request,
            HttpServletRequest httpRequest) {
        String currentUserId = (String) httpRequest.getAttribute("userId");
        String currentRole = (String) httpRequest.getAttribute("userRole");
        UserResponse response = userService.updateUser(id, request, currentUserId, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response, "User profile updated successfully"));
    }

    @PostMapping("/{id}/kyc")
    @Operation(summary = "Submit KYC information", description = "Submit ID number and ID image URL for verification")
    public ResponseEntity<ApiResponse<UserResponse>> submitKyc(
            @PathVariable String id,
            @Valid @RequestBody KycSubmitRequest request,
            HttpServletRequest httpRequest) {
        String currentUserId = (String) httpRequest.getAttribute("userId");
        String currentRole = (String) httpRequest.getAttribute("userRole");
        UserResponse response = userService.submitKyc(id, request, currentUserId, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response, "KYC information submitted successfully"));
    }

    @PatchMapping("/{id}/kyc-status")
    @Operation(summary = "Update user KYC status (Internal)", description = "Called internally by admin-service to approve or reject user KYC profile")
    public ResponseEntity<ApiResponse<UserResponse>> updateKycStatus(
            @PathVariable String id,
            @Valid @RequestBody UpdateKycStatusRequest request,
            HttpServletRequest httpRequest) {
        Boolean isInternalCall = (Boolean) httpRequest.getAttribute("isInternalCall");
        UserResponse response = userService.updateKycStatus(id, request, isInternalCall);
        return ResponseEntity.ok(ApiResponse.success(response, "User KYC status updated to " + request.getKycStatus()));
    }

    @GetMapping
    @Operation(summary = "List users with pagination (Admin only)", description = "Admin directory search and pagination")
    public ResponseEntity<ApiResponse<PageResponse<UserResponse>>> getUsers(
            @RequestParam(required = false) String search,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int limit,
            HttpServletRequest httpRequest) {
        String currentRole = (String) httpRequest.getAttribute("userRole");
        PageResponse<UserResponse> response = userService.getUsers(search, page, limit, currentRole);
        return ResponseEntity.ok(ApiResponse.success(response));
    }
}
