package com.ptpmhdv.userservice.service;

import com.ptpmhdv.userservice.dto.*;
import com.ptpmhdv.userservice.exception.DuplicateResourceException;
import com.ptpmhdv.userservice.exception.ForbiddenException;
import com.ptpmhdv.userservice.exception.ResourceNotFoundException;
import com.ptpmhdv.userservice.exception.UnauthorizedException;
import com.ptpmhdv.userservice.model.KycStatus;
import com.ptpmhdv.userservice.model.User;
import com.ptpmhdv.userservice.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
@RequiredArgsConstructor
public class UserServiceImpl implements UserService {

    private final UserRepository userRepository;

    @Override
    @Transactional
    public UserResponse createUser(CreateUserRequest request, Boolean isInternalCall) {
        if (!Boolean.TRUE.equals(isInternalCall)) {
            throw new UnauthorizedException("Unauthorized: POST /api/users is restricted to internal service calls with valid X-Internal-Key");
        }

        if (userRepository.existsByAuthUserId(request.getAuthUserId())) {
            throw new DuplicateResourceException("User with authUserId " + request.getAuthUserId() + " already exists");
        }

        if (userRepository.existsByEmail(request.getEmail())) {
            throw new DuplicateResourceException("User with email " + request.getEmail() + " already exists");
        }

        User user = User.builder()
                .id(UUID.randomUUID().toString())
                .authUserId(request.getAuthUserId())
                .email(request.getEmail())
                .kycStatus(KycStatus.NONE)
                .build();

        User savedUser = userRepository.save(user);
        return UserResponse.fromEntity(savedUser);
    }

    @Override
    @Transactional(readOnly = true)
    public UserResponse getUserById(String id) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User not found with id: " + id));
        return UserResponse.fromEntity(user);
    }

    @Override
    @Transactional(readOnly = true)
    public UserResponse getUserByAuthUserId(String authUserId) {
        User user = userRepository.findByAuthUserId(authUserId)
                .orElseThrow(() -> new ResourceNotFoundException("User not found with authUserId: " + authUserId));
        return UserResponse.fromEntity(user);
    }

    @Override
    @Transactional
    public UserResponse updateUser(String id, UpdateUserRequest request, String currentUserId, String currentRole) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User not found with id: " + id));

        validateOwnershipOrAdmin(user, currentUserId, currentRole);

        if (request.getFullName() != null && !request.getFullName().isBlank()) {
            user.setFullName(request.getFullName().trim());
        }
        if (request.getPhone() != null && !request.getPhone().isBlank()) {
            user.setPhone(request.getPhone().trim());
        }
        if (request.getAddress() != null && !request.getAddress().isBlank()) {
            user.setAddress(request.getAddress().trim());
        }

        User updatedUser = userRepository.save(user);
        return UserResponse.fromEntity(updatedUser);
    }

    @Override
    @Transactional
    public UserResponse submitKyc(String id, KycSubmitRequest request, String currentUserId, String currentRole) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User not found with id: " + id));

        validateOwnershipOrAdmin(user, currentUserId, currentRole);

        user.setIdNumber(request.getIdNumber().trim());
        user.setIdImageUrl(request.getIdImageUrl().trim());
        user.setKycStatus(KycStatus.PENDING);

        User updatedUser = userRepository.save(user);
        return UserResponse.fromEntity(updatedUser);
    }

    @Override
    @Transactional
    public UserResponse updateKycStatus(String id, UpdateKycStatusRequest request, Boolean isInternalCall) {
        if (!Boolean.TRUE.equals(isInternalCall)) {
            throw new UnauthorizedException("Unauthorized: Updating KYC status is restricted to internal calls with X-Internal-Key");
        }

        User user = userRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("User not found with id: " + id));

        user.setKycStatus(request.getKycStatus());
        User updatedUser = userRepository.save(user);
        return UserResponse.fromEntity(updatedUser);
    }

    @Override
    @Transactional(readOnly = true)
    public PageResponse<UserResponse> getUsers(String search, int page, int limit, String currentRole) {
        if (!"ADMIN".equalsIgnoreCase(currentRole)) {
            throw new ForbiddenException("Forbidden: Only ADMIN users can view user directory");
        }

        int pageIndex = Math.max(0, page - 1);
        int pageSize = Math.max(1, Math.min(limit, 100));
        PageRequest pageRequest = PageRequest.of(pageIndex, pageSize, Sort.by(Sort.Direction.DESC, "createdAt"));

        Page<User> userPage;
        if (search != null && !search.isBlank()) {
            String query = search.trim();
            userPage = userRepository.findByEmailContainingIgnoreCaseOrFullNameContainingIgnoreCase(query, query, pageRequest);
        } else {
            userPage = userRepository.findAll(pageRequest);
        }

        return PageResponse.fromPage(userPage, UserResponse::fromEntity);
    }

    private void validateOwnershipOrAdmin(User user, String currentUserId, String currentRole) {
        if ("ADMIN".equalsIgnoreCase(currentRole)) {
            return;
        }
        if (currentUserId != null && (currentUserId.equals(user.getId()) || currentUserId.equals(user.getAuthUserId()))) {
            return;
        }
        throw new ForbiddenException("Forbidden: You do not have permission to modify this profile");
    }
}
