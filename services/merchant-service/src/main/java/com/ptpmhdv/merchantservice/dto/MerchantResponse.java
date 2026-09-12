package com.ptpmhdv.merchantservice.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ptpmhdv.merchantservice.model.Merchant;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MerchantResponse {
    private String id;
    private String ownerId;
    private String businessName;
    private String taxId;
    private String bankAccount;
    private MerchantStatus status;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    private Instant createdAt;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", timezone = "UTC")
    private Instant updatedAt;

    public static MerchantResponse fromEntity(Merchant merchant) {
        return MerchantResponse.builder()
                .id(merchant.getId())
                .ownerId(merchant.getOwnerId())
                .businessName(merchant.getBusinessName())
                .taxId(merchant.getTaxId())
                .bankAccount(merchant.getBankAccount())
                .status(merchant.getStatus())
                .createdAt(merchant.getCreatedAt())
                .updatedAt(merchant.getUpdatedAt())
                .build();
    }
}
