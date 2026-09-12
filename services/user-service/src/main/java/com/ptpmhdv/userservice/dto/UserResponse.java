package com.ptpmhdv.userservice.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ptpmhdv.userservice.model.KycStatus;
import com.ptpmhdv.userservice.model.User;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserResponse {
    private String id;
    private String authUserId;
    private String email;
    private String fullName;
    private String phone;
    private String address;
    private KycStatus kycStatus;
    private String idNumber;
    private String idImageUrl;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    private Instant createdAt;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    private Instant updatedAt;

    public static UserResponse fromEntity(User user) {
        return UserResponse.builder()
                .id(user.getId())
                .authUserId(user.getAuthUserId())
                .email(user.getEmail())
                .fullName(user.getFullName())
                .phone(user.getPhone())
                .address(user.getAddress())
                .kycStatus(user.getKycStatus())
                .idNumber(user.getIdNumber())
                .idImageUrl(user.getIdImageUrl())
                .createdAt(user.getCreatedAt())
                .updatedAt(user.getUpdatedAt())
                .build();
    }
}
