package com.ptpmhdv.userservice.service;

import com.ptpmhdv.userservice.dto.*;

public interface UserService {
    UserResponse createUser(CreateUserRequest request, Boolean isInternalCall);
    UserResponse getUserById(String id);
    UserResponse getUserByAuthUserId(String authUserId);
    UserResponse updateUser(String id, UpdateUserRequest request, String currentUserId, String currentRole);
    UserResponse submitKyc(String id, KycSubmitRequest request, String currentUserId, String currentRole);
    UserResponse updateKycStatus(String id, UpdateKycStatusRequest request, Boolean isInternalCall);
    PageResponse<UserResponse> getUsers(String search, int page, int limit, String currentRole);
}
